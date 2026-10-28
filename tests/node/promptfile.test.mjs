// Prompts live in plugin/prompts/default.json. With the default file, every prompt must be exactly what the code
// produced before the move (fixtures/prompts.snapshot.json was made from the old code).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import './ststub.mjs';
const root = new URL('../../', import.meta.url);
const def = JSON.parse(fs.readFileSync(new URL('plugin/prompts/default.json', root), 'utf8'));
const ext = await import('../../extension/index.js');
const uiPrompts = await import('../../plugin/ui/prompts.mjs');
const patches = await import('../../plugin/ui/patches.mjs');
const placeform = await import('../../plugin/ui/placeform.mjs');
const { cases } = await import('./fixtures/prompt-cases.mjs');
const snap = JSON.parse(fs.readFileSync(new URL('fixtures/prompts.snapshot.json', import.meta.url), 'utf8'));
ext.setPrompts(def); uiPrompts.setPrompts(def);

test('default prompts give byte-identical output to the old code', () => {
    const now = cases({ ext, patches, placeform });
    assert.deepEqual(Object.keys(now).sort(), Object.keys(snap).sort());
    for (const k of Object.keys(snap)) assert.equal(now[k], snap[k], `prompt case ${k} changed`);
});
test('every entry has id, title, description, text and placeholders that match the text', () => {
    const ids = new Set();
    for (const e of def.prompts) {
        assert.ok(e.id && !ids.has(e.id), `bad or duplicate id ${e.id}`); ids.add(e.id);
        assert.equal(typeof e.title, 'string'); assert.equal(typeof e.description, 'string'); assert.equal(typeof e.text, 'string');
        assert.deepEqual(e.placeholders.map(p => p.name).sort(), uiPrompts.placeholdersIn(e.text).sort(), `placeholders of ${e.id}`);
    }
});
test('op docs are a generated placeholder, not text in the file', () => {
    const sys = def.prompts.find(e => e.id === 'change.system');
    assert.match(sys.text, /\{\{edit_types\}\}/);
    assert.ok(sys.placeholders.find(p => p.name === 'edit_types').generated);
    assert.ok(!sys.text.includes('"op":"add_exit"'));
});
test('the extension copy of prompts.mjs matches the plugin one', () => {
    const a = fs.readFileSync(new URL('plugin/ui/prompts.mjs', root), 'utf8');
    const b = fs.readFileSync(new URL('extension/prompts.mjs', root), 'utf8');
    assert.equal(b.split('\n').slice(1).join('\n'), a);
});
test('an override changes the prompt, values are not re-filled', () => {
    ext.setPrompts({ ...Object.fromEntries(def.prompts.map(e => [e.id, e.text])), 'dig.stay': 'X {{said}} Y' });
    assert.equal(ext.digStayPrompt('said {{who}}'), 'X said {{who}} Y');
    ext.setPrompts(def);
});
