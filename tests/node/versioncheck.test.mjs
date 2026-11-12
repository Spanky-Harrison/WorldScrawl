// The one version check: the extension and the plugin carry the same number, compared once on load. A mismatch (or a
// plugin from before the check) turns WorldScrawl off: one message, and nothing of it runs. Each case loads the real
// extension in a fresh Node process against a copy of the plugin's code with its version.mjs changed.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { REPO } from './helpers.mjs';

const { WORLDSCRAWL_VERSION: EXT } = await import('../../extension/version.mjs');
const { WORLDSCRAWL_VERSION: PLUGIN } = await import('../../plugin/shared/version.mjs');
const shared = await import('../../extension/shared.mjs');

/** Load extension/index.js in a new process with the plugin's version.mjs as `version` (null: no file). */
function load(version) {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'wsver-'));
    fs.cpSync(path.join(REPO, 'extension'), path.join(d, 'extension'), { recursive: true });
    for (const sub of ['shared', 'ui']) fs.cpSync(path.join(REPO, 'plugin', sub), path.join(d, 'plugin', sub), { recursive: true });
    const vf = path.join(d, 'plugin', 'shared', 'version.mjs');
    if (version === null) fs.rmSync(vf); else fs.writeFileSync(vf, `export const WORLDSCRAWL_VERSION = ${version};\n`);
    const script = path.join(d, 'run.mjs');
    fs.writeFileSync(script, `
import ${JSON.stringify(new URL('./ststub.mjs', import.meta.url).href)};
const toasts = [], handlers = [];
globalThis.toastr = { error: (m) => toasts.push(String(m)), info() {}, warning() {}, success() {} };
const c = SillyTavern.getContext();
c.eventTypes = { CHAT_CHANGED: 'chat_changed', MESSAGE_RECEIVED: 'message_received', MESSAGE_SWIPED: 'message_swiped', CHARACTER_MESSAGE_RENDERED: 'r1', USER_MESSAGE_RENDERED: 'r2', TOOL_CALLS_PERFORMED: 't' };
c.eventSource = { on: ev => handlers.push(ev) };
c.chatMetadata = { worldscrawl_enabled: true };
const ext = await import(${JSON.stringify(path.join(d, 'extension', 'index.js'))});
const chat = [{ is_user: true, mes: 'I [look] around.', swipe_id: 0, extra: {} }];
c.chat = chat;
await globalThis.worldscrawlInterceptor(chat, 0, () => {}, 'normal');
console.log('RESULT ' + JSON.stringify({ toasts, handlers: handlers.length, on: ext.isOn(), mes: chat[0].mes }));
`);
    try {
        const out = execFileSync(process.execPath, [script], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 60000 });
        return JSON.parse(out.split('\n').find(l => l.startsWith('RESULT ')).slice(7));
    } finally { fs.rmSync(d, { recursive: true, force: true }); }
}
const MESSAGE = v => `WorldScrawl is off: the extension (version ${EXT}) and the server plugin (version ${v}) don't match. Update both to the same release, then restart SillyTavern.`;

test('one number on each side, and they are the same release', () => {
    assert.equal(EXT, PLUGIN);
    assert.equal(shared.offReason, null, 'this repo loads on');
});

test('same version: WorldScrawl starts (events, interceptor), no message', () => {
    const r = load(EXT);
    assert.deepEqual(r.toasts, []);
    assert.ok(r.handlers > 5, 'its events are registered');
    assert.equal(r.on, true);
    assert.equal(r.mes, 'I look around.', 'the interceptor ran (brackets unwrapped for the narrator)');
});

for (const [label, v, shown] of [['an older plugin', EXT - 1, EXT - 1], ['a newer plugin', EXT + 1, EXT + 1], ['a plugin from before the check (no version file)', null, 'unknown']]) {
    test(`${label}: WorldScrawl turns itself off with one message; nothing of it runs`, () => {
        const r = load(v);
        assert.deepEqual(r.toasts, [MESSAGE(shown)], 'one message, once');
        assert.equal(r.handlers, 0, 'no events registered');
        assert.equal(r.on, false, 'off in every chat');
        assert.equal(r.mes, 'I [look] around.', 'the interceptor did nothing');
    });
}

test('no other version check is left: no per-card update line, no card versions', () => {
    const files = ['extension', 'plugin/ui', 'plugin/shared'].flatMap(d => fs.readdirSync(path.join(REPO, d)).filter(f => /\.m?js$/.test(f)).map(f => path.join(d, f)));
    for (const f of files) assert.doesNotMatch(fs.readFileSync(path.join(REPO, f), 'utf8'), /CARD_VERSION|CARD_API|UPDATE_LINE|update the plugin|pluginError|PLUGIN_API|PLUGIN_VERSION/, f);
    const uses = files.filter(f => /WORLDSCRAWL_VERSION/.test(fs.readFileSync(path.join(REPO, f), 'utf8')));
    assert.deepEqual(uses.sort(), ['extension/shared.mjs', 'extension/version.mjs', 'plugin/shared/version.mjs'], 'compared in one place');
});
