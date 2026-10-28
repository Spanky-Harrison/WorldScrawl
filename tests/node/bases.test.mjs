// Shared locked base lines: every generic system prompt ends with one of pick.base_one / pick.base_json / pick.base_text
// filled in as {{reply}}. Old saved profiles that replaced a whole system prompt keep working.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import './ststub.mjs';
const def = JSON.parse(fs.readFileSync(new URL('../../plugin/prompts/default.json', import.meta.url), 'utf8'));
const ext = await import('../../extension/index.js');
const byId = Object.fromEntries(def.prompts.map(e => [e.id, e]));
const texts = over => ({ ...Object.fromEntries(def.prompts.map(e => [e.id, e.text])), ...over });
const USES = { 'pick.system': ['one', ext.pickSys], 'intent.system': ['one', ext.intentSys], 'dig.system': ['json', ext.digSys],
    'change.scope_system': ['json', ext.scopeSys], 'change.system': ['json', () => ext.patchSys({ opDocs: () => 'OPS' })],
    'discover.system': ['json', ext.discoverSys], 'expand.system': ['text', ext.expandSys] };

test('the bases are locked and every generic system prompt uses one', () => {
    for (const k of ['one', 'json', 'text']) assert.ok(byId[`pick.base_${k}`].locked, k);
    for (const [id, [k, fn]] of Object.entries(USES)) {
        assert.match(byId[id].text, /\{\{reply\}\}/, id);
        ext.setPrompts(def);
        assert.ok(fn().includes(byId[`pick.base_${k}`].text), `${id} ends with base ${k}`);
        assert.ok(!fn().includes('{{reply}}'), id);
    }
});
test('editing a base changes every call that uses it', () => {
    ext.setPrompts(texts({ 'pick.base_json': 'Answer in JSON, nothing more' }));
    for (const [id, [k, fn]] of Object.entries(USES)) assert.equal(fn().includes('Answer in JSON, nothing more'), k === 'json', id);
});
test('a saved profile that replaced a whole old system prompt still works verbatim', () => {
    ext.setPrompts(texts({ 'dig.system': 'OLD FULL TEXT. Reply with JSON only: {}', 'intent.system': 'Old intent. Reply with exactly one option from the list and nothing else.' }));
    assert.equal(ext.digSys(), 'OLD FULL TEXT. Reply with JSON only: {}');
    assert.equal(ext.intentSys(), 'Old intent. Reply with exactly one option from the list and nothing else.');
    ext.setPrompts(def);
});
