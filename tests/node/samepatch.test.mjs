// Ops that point at places made earlier in the same patch, and an add_exit that repeats create_place's own door pair.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { RIVERTON } from './helpers.mjs';
import { read_world_raw } from '../../plugin/world.mjs';
import { applyPatch, getRoom, readChangeAnswer, opDocs, PatchError } from '../../plugin/ui/patches.mjs';

const UP = 'riverton:drowned_rat/upstairs';
const raw = () => read_world_raw(RIVERTON)[1];
const mind = (extra = {}) => readChangeAnswer({ ops: [{ op: 'create_place', name: 'Secret Mind Dimension', description: 'A swirl of thought.', exits: [{ to: UP, direction: 'portal', return_direction: 'shimmering portal' }], lasts: '1h', ...extra }] }).ops[0];
const made = r => Object.entries(r.riverton.subregions.drowned_rat.locations).find(([, v]) => v.name === 'Secret Mind Dimension');

test('an add_exit repeating the door pair create_place made is dropped, its extra fields merged', () => {
    const r = raw();
    const out = applyPatch(r, { ops: [mind(), { op: 'add_exit', loc: UP, to: 'new:secret mind dimension', direction: 'shimmering portal', return_direction: 'portal', description: 'A rip in the air hums softly.' }] });
    const [id] = made(r), a = `riverton:drowned_rat/${id}`;
    const up = getRoom(r, UP).exits.filter(e => e.to === a);
    assert.equal(up.length, 1);
    assert.equal(up[0].description, 'A rip in the air hums softly.');
    assert.match(out.summary[1], /merged/);
});
test('"new:<ref>" points at a place made earlier in the patch', () => {
    const r = raw();
    applyPatch(r, { ops: [mind({ ref: 'mind' }), { op: 'set_description', loc: 'new:mind', text: 'Thoughts drift like fish.' }] });
    assert.equal(made(r)[1].description, 'Thoughts drift like fish.');
    assert.throws(() => applyPatch(raw(), { ops: [mind(), { op: 'set_description', loc: 'new:nope', text: 'x' }] }), PatchError);
});
test('a guessed address for a new place resolves to it', () => {
    const r = raw();
    applyPatch(r, { ops: [mind(), { op: 'set_description', loc: 'riverton:secret_mind_dimension/secret_mind_dimension', text: 'Guessed.' }] });
    assert.equal(made(r)[1].description, 'Guessed.');
});
test('the op docs say create_place makes the exit pair and explain ref / new:', () => {
    const d = opDocs();
    assert.match(d, /already makes the door pair/);
    assert.match(d, /never add a separate add_exit/);
    assert.match(d, /"new:label"/);
});
test('change prompts count temporary changes and drop the "lasting" wording', () => {
    const def = JSON.parse(fs.readFileSync(new URL('../../plugin/prompts/default.json', import.meta.url), 'utf8'));
    const by = Object.fromEntries(def.prompts.map(e => [e.id, e.text]));
    for (const id of ['change.system', 'change.scope', 'change.scope_system', 'narration.flag_hint']) assert.doesNotMatch(by[id], /lasting|permanently/, id);
    assert.match(by['change.system'], /portal open for 1 hour/);
    assert.match(by['change.system'], /Moment-to-moment action/);
});
