// B3: discovery and no-op card hygiene, through the real handlers (flagMessage / applyTrackerResult -> analyzeDiscovery
// with a stubbed model and the real map server in-process -> renderPatchCards on the fake DOM).
import './ststub.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { clientDir, RIVERTON, TAVERN } from './helpers.mjs';
import { makeDoc } from './fakedom.mjs';

const ext = await import('../../extension/index.js');
const { renderPatchCards } = await import('../../extension/waits.mjs');
const { applyTrackerResult, flagMessage } = await import('../../extension/discovery.mjs');
const { readTrackerAnswer } = await import('../../extension/tracker.mjs');
const diff = await import('../../plugin/ui/diffview.mjs');
const patchesExt = await import('../../extension/patches.mjs');
patchesExt.useDiffLib(diff);
patchesExt.useFormLib(await import('../../plugin/ui/patchform.mjs'));
const { rememberWorlds, loadCalendar } = await import('../../extension/clock.mjs');
await loadCalendar();

const PROMPTS = JSON.parse(fs.readFileSync(new URL('../../plugin/prompts/default.json', import.meta.url), 'utf8'));
const FLAG = 'worldscrawl_flag', PATCHES = 'worldscrawl_patches';
const server = clientDir(path.dirname(RIVERTON));
const flush = (ms = 20) => new Promise(r => setTimeout(r, ms));
globalThis.fetch = async (url, opts = {}) => {
    const u = new URL(String(url), 'http://local');
    const r = server.request(opts.method || 'GET', u.pathname.replace(/^\/api\/plugins\/worldscrawl/, '') + u.search, { json: opts.body ? JSON.parse(opts.body) : undefined });
    return { ok: r.status_code < 400, status: r.status_code, headers: { get: k => r.headers.get(k) }, json: async () => r.json() };
};
const ROOM = { name: 'Pantry', description: 'A narrow pantry lined with shelves of jars.', direction: 'pantry door', return_direction: 'out' };
function boot(discovery = ROOM) {
    ext.setPrompts(PROMPTS);
    rememberWorlds({ default: 'riverton', worlds: [{ id: 'riverton', name: 'Riverton', cast: [] }] });
    const c = SillyTavern.getContext();
    c.chatId = 'disc'; c.getCurrentChatId = () => 'disc';
    c.chatMetadata = { worldscrawl_enabled: true };
    c.saveChat = async () => {}; c.saveSettingsDebounced = () => {}; c.updateMessageBlock = () => {}; c.setExtensionPrompt = () => {};
    Object.assign(ext.settings(), { flagTags: true, flagNpcs: true, autoKeep: false });
    const calls = [];
    c.generateRaw = async args => {
        const sys = String(args?.systemPrompt ?? '');
        calls.push(sys);
        return /You add one room to a role-play map/.test(sys) ? JSON.stringify(discovery) : '{}';
    };
    c.chat = [
        { is_user: true, mes: 'I try the little door behind the bar.', swipe_id: 0, extra: { worldscrawl_location: TAVERN } },
        { is_user: false, mes: 'It opens on a narrow pantry.', swipe_id: 0, swipe_info: [{ extra: {} }], extra: {} },
    ];
    return { c, calls };
}
async function settled(id = 1) {
    for (let i = 0; i < 200; i++) { const f = SillyTavern.getContext().chat[id]?.extra?.[FLAG]; if (f && f.status !== 'working') return f; await flush(10); }
    throw new Error('the flag never settled');
}
const draw = () => { const doc = makeDoc([0, 1, 2]); globalThis.document = doc; renderPatchCards(); return doc; };
const btns = doc => doc.querySelectorAll('.worldscrawl_card_btn').map(b => b.textContent);
const trackerDiscover = note => readTrackerAnswer(JSON.stringify({ place: { changed: true, kind: 'discover', note }, people: [], wait: null }));

test('a discovery answer of {"none": true} makes no room: status nothing, with the reason', async () => {
    const { c } = boot({ none: true });
    await flagMessage(1, { note: 'a door', kind: 'discover', source: 'command' });
    const f = await settled();
    assert.equal(f.status, 'nothing');
    assert.equal(f.error, 'the story opens no new door here');
    assert.equal(c.chat[1].extra[PATCHES], undefined);
    assert.equal(f.proposal, undefined);
});

test('the discovery prompt offers none and door', () => {
    const sys = PROMPTS.prompts.find(p => p.id === 'discover.system').text, q = PROMPTS.prompts.find(p => p.id === 'discover.question').text;
    assert.match(sys, /"door": true\}/);
    assert.match(sys, /Or reply \{"none": true\} when the story does not actually open a new door or way here/);
    assert.match(sys, /door: false for an open way \(an arch, a curtain, a gap in the wall\)/);
    assert.match(q, /or reply \{"none": true\} if the story opens no new door\.$/);
});

test('a tracker discovery waits for Approve with Auto-keep off; Approve keeps it', async () => {
    const { c } = boot();
    await applyTrackerResult(1, trackerDiscover('the little door behind the bar'));
    const f = await settled();
    assert.equal(f.status, 'review');
    assert.equal(c.chat[1].extra[PATCHES], undefined, 'nothing on the map yet');
    const doc = draw();
    assert.ok(btns(doc).includes('Approve'), btns(doc).join(', '));
    doc.querySelectorAll('.worldscrawl_card_btn').find(b => b.textContent === 'Approve').click();
    await flush(80);
    assert.equal(c.chat[1].extra[FLAG].status, 'kept');
    assert.ok(c.chat[1].extra[PATCHES]?.length);
});

test('a tracker discovery is kept at once with Auto-keep on; a player or narrator discovery always is', async () => {
    let { c } = boot();
    ext.settings().autoKeep = true;
    await applyTrackerResult(1, trackerDiscover('the little door behind the bar'));
    await flush(50);
    assert.equal((await settled()).status, 'kept');
    assert.ok(c.chat[1].extra[PATCHES]?.length);
    ext.settings().autoKeep = false;
    for (const source of ['command', 'tag', 'tool']) {
        ({ c } = boot());
        await flagMessage(1, { note: 'the little door', kind: 'discover', source });
        await flush(50);
        assert.equal((await settled()).status, 'kept', source);
    }
});

// ---- The two sides of the new door agree on the card.
const exitRow = (rows, key, dir) => rows.find(r => r.key === key)?.fields.find(x => x.field === 'exits')?.new.find(l => l.startsWith(`${dir} →`)) ?? '';
test('door both sides: the card shows a closed door from the old room and the new one; door false is an open way on both', async () => {
    for (const [answer, word] of [[ROOM, 'closed door'], [{ ...ROOM, door: false }, 'open way']]) {
        boot(answer);
        await applyTrackerResult(1, trackerDiscover('the little door behind the bar'));
        const f = await settled();
        const rows = diff.fieldDiffs(f.proposal.before, f.proposal.after, f.proposal.relocate);
        const added = rows.find(r => r.status === 'added');
        assert.ok(added, 'the new room');
        assert.match(exitRow(rows, TAVERN, 'pantry door'), new RegExp(`\\(${word}\\)`), `old room side (${word})`);
        assert.match(exitRow(rows, added.key, 'out'), new RegExp(`\\(${word}\\)`), `new room side (${word})`);
    }
});

test('exitState reads a door set only on the other side, flipped; its own barrier wins', () => {
    assert.equal(diff.exitState({ direction: 'a' }, { barrier: { locked: true } }), 'locked door');
    assert.equal(diff.exitState({ direction: 'a', barrier: { starts_open: true } }, { barrier: { locked: true } }), 'open door');
    assert.equal(diff.exitState({ direction: 'a' }, null), 'open way');
});

// ---- No-op cards go once the player has sent another line.
test('a "No map change found" card shows until the next player line, then is not drawn; review and error cards stay', async () => {
    const { c } = boot();
    c.chat[1].extra[FLAG] = { swipe: 0, status: 'nothing', start: 0, loc: TAVERN, source: 'tracker' };
    assert.match(draw().querySelector('.worldscrawl_patchcard')?.textContent ?? '', /No map change found/);
    c.chat.push({ is_user: false, is_system: true, mes: '[notice]', extra: { worldscrawl_notice: true } });
    assert.match(draw().querySelector('.worldscrawl_patchcard')?.textContent ?? '', /No map change found/, 'a notice is not a player line');
    c.chat.push({ is_user: true, mes: 'I head upstairs.', swipe_id: 0, extra: {} });
    assert.equal(draw().querySelector('.worldscrawl_patchcard'), null);
    c.chat[1].extra[FLAG] = { swipe: 0, status: 'error', error: 'the map server is down', start: 0, loc: TAVERN };
    assert.ok(draw().querySelector('.worldscrawl_patchcard'), 'an error card stays');
    c.chat.length = 2;
    delete c.chat[1].extra[FLAG];
    await applyTrackerResult(1, trackerDiscover('the little door behind the bar'));
    await settled();
    c.chat.push({ is_user: true, mes: 'I wait.', swipe_id: 0, extra: {} });
    assert.ok(btns(draw()).includes('Approve'), 'a card waiting for review stays');
});
