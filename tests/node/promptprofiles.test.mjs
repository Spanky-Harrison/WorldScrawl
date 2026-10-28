// Prompt profiles on the server: stored per user, only overrides, Default read-only, survives a restart (re-read from disk).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { handlePrompts, hashText, storeFile } from '../../plugin/prompts.mjs';
import { userRoot } from '../../plugin/index.mjs';

const DEF = new URL('../../plugin/prompts/default.json', import.meta.url).pathname;
const def = JSON.parse(fs.readFileSync(DEF, 'utf8'));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'wsprompts-'));
const call = (root, m, u, b, f = DEF) => handlePrompts(m, u, b, root, f);

test('fresh user: Default selected, active prompts are the default text', () => {
    const r = call(tmp(), 'GET', '/prompts/active');
    assert.equal(r.body.profile, 'Default');
    for (const e of def.prompts) assert.equal(r.body.prompts[e.id], e.text);
    assert.equal(call(tmp(), 'GET', '/somethingelse'), null);
});
test('Default is read-only; a new profile stores only its overrides with the base text and hash', () => {
    const root = tmp();
    assert.equal(call(root, 'POST', '/prompts/override', { profile: 'Default', id: 'travel.question', text: 'x' }).status, 400);
    assert.equal(call(root, 'POST', '/prompts/profile', { action: 'new', name: 'default' }).status, 400);
    assert.equal(call(root, 'POST', '/prompts/profile', { action: 'new', name: 'Mine' }).status, 200);
    assert.equal(call(root, 'POST', '/prompts/profile', { action: 'new', name: 'mine' }).status, 400, 'names are unique');
    const r = call(root, 'POST', '/prompts/override', { profile: 'Mine', id: 'travel.question', text: 'Stay? {{said}}' });
    const o = r.body.profiles.Mine.overrides['travel.question'];
    const base = def.prompts.find(e => e.id === 'travel.question').text;
    assert.deepEqual(o, { text: 'Stay? {{said}}', base_hash: hashText(base), base_text: base, default_changed: false });
    assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(storeFile(root), 'utf8')).profiles.Mine.overrides), ['travel.question']);
    // "restart": a new read from disk
    const a = call(root, 'GET', '/prompts/active').body;
    assert.equal(a.profile, 'Mine'); assert.equal(a.prompts['travel.question'], 'Stay? {{said}}'); assert.equal(a.prompts['dig.style'], def.prompts.find(e => e.id === 'dig.style').text);
    assert.equal(fs.readFileSync(DEF, 'utf8'), fs.readFileSync(DEF, 'utf8'));
    call(root, 'POST', '/prompts/reset', { profile: 'Mine', id: 'travel.question' });
    assert.deepEqual(call(root, 'GET', '/prompts').body.profiles.Mine.overrides, {});
    call(root, 'POST', '/prompts/override', { profile: 'Mine', id: 'travel.question', text: base });
    assert.deepEqual(call(root, 'GET', '/prompts').body.profiles.Mine.overrides, {}, 'saving the default text keeps no override');
});
test('duplicate, rename, delete, select', () => {
    const root = tmp();
    call(root, 'POST', '/prompts/profile', { action: 'new', name: 'A' });
    call(root, 'POST', '/prompts/override', { profile: 'A', id: 'dig.style', text: 'N' });
    call(root, 'POST', '/prompts/profile', { action: 'duplicate', from: 'A', name: 'B' });
    assert.equal(call(root, 'GET', '/prompts/active').body.prompts['dig.style'], 'N');
    assert.equal(call(root, 'POST', '/prompts/profile', { action: 'rename', from: 'B', name: 'A' }).status, 400);
    let r = call(root, 'POST', '/prompts/profile', { action: 'rename', from: 'B', name: 'C' });
    assert.equal(r.body.selected, 'C'); assert.ok(!r.body.profiles.B);
    assert.equal(call(root, 'POST', '/prompts/profile', { action: 'delete', name: 'Default' }).status, 400);
    r = call(root, 'POST', '/prompts/profile', { action: 'delete', name: 'C' });
    assert.equal(r.body.selected, 'Default');
    r = call(root, 'POST', '/prompts/select', { profile: 'A' }); assert.equal(r.body.selected, 'A');
    assert.equal(call(root, 'POST', '/prompts/select', { profile: 'Nope' }).status, 400);
});
test('when the default text changes later, the override says so and keeps the old default for a diff', () => {
    const root = tmp(), d = tmp(), f = path.join(d, 'default.json');
    fs.writeFileSync(f, JSON.stringify(def));
    call(root, 'POST', '/prompts/profile', { action: 'new', name: 'A' }, f);
    call(root, 'POST', '/prompts/override', { profile: 'A', id: 'dig.style', text: 'Mine' }, f);
    const changed = structuredClone(def); changed.prompts.find(e => e.id === 'dig.style').text = 'New default';
    fs.writeFileSync(f, JSON.stringify(changed)); const t = new Date(Date.now() + 5000); fs.utimesSync(f, t, t);
    const o = call(root, 'GET', '/prompts', null, f).body.profiles.A.overrides['dig.style'];
    assert.equal(o.default_changed, true); assert.equal(o.base_text, def.prompts.find(e => e.id === 'dig.style').text);
});
test('per-user folder comes from SillyTavern req.user', () => {
    assert.equal(userRoot({ user: { directories: { root: '/st/data/alice' } } }, {}), '/st/data/alice');
    assert.equal(userRoot({}, { WORLDSCRAWL_USER_DIR: '/x' }), '/x');
});
