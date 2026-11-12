// v4 acceptance through the production entries: chat cards, the map channel, npcChatEdit,
// applyTrackerResult, ensureAppearanceRebuilds, settleNpc, and exportNpc.
import './ststub.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

await import('../../extension/index.js');
const scene = await import('../../extension/scene.mjs');
const ext = await import('../../extension/index.js');
const { npcAt, claimResult, npcPlayState, NPC_KEY } = await import('../../extension/npc.mjs');
const { renderPatchCards } = await import('../../extension/waits.mjs');
const { openMapChannel } = await import('../../extension/mapwindow.mjs');
const { invalidateAppearance } = await import('../../extension/scene.mjs');
const { readChangeAnswer } = await import('../../plugin/shared/patches.mjs');
const { castPanel } = await import('../../plugin/ui/castpanel.mjs');
const { makeDoc } = await import('./fakedom.mjs');
const { loadCalendar, rememberWorlds } = await import('../../extension/clock.mjs');
await loadCalendar();
const { syncSwipeExtra } = await import('../../extension/discovery.mjs');
(await import('../../extension/patches.mjs')).useDiffLib(await import('../../plugin/ui/diffview.mjs'));

const HESK = { ok: true, id: 'hesk', name: 'Hesk', line: 'landlady', looks: 'copper braids', body: 'sturdy', outfit: 'wool', file: 'hesk.json' };
const PROMPTS = JSON.parse(fs.readFileSync(new URL('../../plugin/prompts/default.json', import.meta.url), 'utf8'));

class Chan {
    static all = [];
    constructor(name) { this.name = name; this.listeners = []; Chan.all.push(this); }
    addEventListener(type, fn) { if (type === 'message') this.listeners.push(fn); }
    postMessage(data) { for (const ch of Chan.all) if (ch !== this && ch.name === this.name) for (const fn of [...ch.listeners]) fn({ data }); }
    close() {}
}
const flush = () => new Promise(r => setTimeout(r, 30));
/** The map window's askST over the fake channel: post, then the `${type}_result` with the same req. */
let guiReq = 0;
function askGui(gui, type, payload) {
    const req = `g${++guiReq}`;
    return new Promise(res => {
        const on = ev => { if (ev.data?.type === `${type}_result` && ev.data.req === req) { gui.listeners = gui.listeners.filter(f => f !== on); res(ev.data); } };
        gui.addEventListener('message', on);
        gui.postMessage({ type, req, ...payload });
    });
}
const promptsOf = () => [];
function boot() {
    ext.setPrompts(PROMPTS);
    rememberWorlds({ default: 'riverton', worlds: [{ id: 'riverton', name: 'Riverton', cast: [HESK] }] });
    const c = SillyTavern.getContext();
    c.chatId = 'c1';
    c.getCurrentChatId = () => 'c1';
    c.chatMetadata = { worldscrawl_enabled: true };
    c.saveChat = async () => {};
    c.saveSettingsDebounced = () => {};
    c.updateMessageBlock = () => {};
    c.setExtensionPrompt = () => {};
    const prompts = [];
    c.generateRaw = async (args) => {
        const p = String(args?.prompt ?? '');
        prompts.push(p);
        if (/Looks line/.test(p)) return '{"looks":"tall copper braids"}';
        return '{"body":"a composed frame","outfit":"a composed cloak"}';
    };
    ext.settings().flagNpcs = true;
    ext.settings().flagTags = true;
    return { c, prompts };
}
function msg(stamps = []) {
    return { mes: 'Hesk is here.', is_user: false, swipe_id: 0, swipe_info: [{ extra: {} }], extra: { worldscrawl_mid: 'm', [NPC_KEY]: stamps } };
}
function appearance({ intent, fields = 'body', layer = {}, lasts = null, start = 0, owner = '' }) {
    const o = scene.makeOwner({ id: 'hesk', intent, fields, layer, lasts, start, message: 'm', swipe: 0, chatId: 'c1' });
    if (owner) { o.owner = owner; o.identity.owner = owner; }
    return o;
}
function commit(o, layer = o.candidate?.layer ?? {}) {
    o.committed = o.kind === 'baseline'
        ? { kind: 'baseline', field: o.candidate?.field || o.field, text: o.candidate?.text ?? '' }
        : { kind: 'appearance', intent: o.intent, fields: o.candidate?.fields || 'body', layer: { ...layer } };
    o.contentId = `c_${o.owner}`;
    o.candidate = null;
    return o;
}
function buttons(root) { return (root.querySelectorAll ? root.querySelectorAll('.worldscrawl_card_btn') : []).map(b => b.textContent); }
function byText(root, sel, text) { return root.querySelectorAll(sel).find(b => b.textContent === text); }
const owners = chat => (chat[0].extra[NPC_KEY] ?? []).filter(s => s.type === 'npc_appearance' || s.type === 'npc_baseline');
const cacheRows = chat => (chat ?? []).some(m => (m.extra?.[NPC_KEY] ?? []).some(s => s.type === 'npc_appearance_cache'));

test('a second proposal shows the replay without that candidate, not the pinned baseline', async () => {
    const { c, prompts } = boot();
    const first = commit(appearance({ intent: 'taller', fields: 'body', layer: { body: 'a towering woman' } }));
    const next = appearance({ intent: 'scarred', fields: 'body', layer: { body: 'a scarred towering woman' }, lasts: 60 });
    const chat = [msg([first, next])];
    c.chat = chat;
    c.generateRaw = async (args) => { prompts.push(String(args.prompt)); return '{"body":"a scarred towering woman","outfit":"wool"}'; };
    const filled = await scene.fillCandidate(chat, next.identity, { baseline: { body: 'sturdy', outfit: 'wool' }, name: 'Hesk', elapsed: 0 });
    assert.equal(filled.ok, true, filled.error);
    assert.equal(next.candidate.lastingPreview.body, 'a towering woman');
    assert.equal(next.candidate.lastingBefore.body, 'a towering woman');
    assert.notEqual(next.candidate.lastingBefore.body, 'sturdy');
    assert.equal(next.candidate.lastingBefore.unresolved, false);
    assert.equal(next.candidate.livePreview.body, 'a scarred towering woman');
    assert.equal(prompts.length, 1, 'only the live overlap is asked; the lasting replay is already known');
    const doc = makeDoc();
    globalThis.document = doc;
    renderPatchCards();
    const card = doc.querySelector('.worldscrawl_npcpending');
    assert.ok(card, 'the chat card rendered the proposal');
    // Temporary on top of an unchanged lasting result: only the live Body row, no lasting rows, no outfit row.
    assert.match(card.textContent, /Body \(for now\)/);
    assert.doesNotMatch(card.textContent, /lasting|Lasting|Outfit|before unresolved/);
    // Same view as a place: one framed panel titled with the name, one changed field.
    assert.equal(card.querySelectorAll('.wsdiff-place').length, 1);
    assert.equal(card.querySelectorAll('.wsdiff-label').length, 1);
    assert.match(card.textContent, /a scarred towering woman/);
    assert.equal(cacheRows(chat), false);
});

test('chat Turn off and the map channel share settleNpc, and Undo does not put the owner back', async () => {
    const { c, prompts } = boot();
    const o = commit(appearance({ intent: 'taller', fields: 'body', layer: { body: 'a towering woman' }, owner: 'ot' }));
    c.chat = [msg([o])];
    const doc = makeDoc();
    globalThis.document = doc;
    Chan.all = [];
    globalThis.BroadcastChannel = Chan;
    openMapChannel();
    const gui = new Chan('worldscrawl');
    renderPatchCards();
    const off = byText(doc, '.worldscrawl_card_btn', 'Turn off');
    assert.ok(off);
    off.click();
    await flush();
    assert.equal(o.off, true);
    assert.equal(npcAt(c.chat, 0, [HESK], 'hesk').body, 'sturdy');
    assert.equal(prompts.filter(p => !/Looks line/.test(p)).length, 0);
    gui.postMessage({ type: 'npc_decide', chatId: 'c1', req: 7, identity: o.identity, decisionRev: o.decisionRev, action: 'on', payload: {} });
    await flush();
    assert.equal(o.off, false);
    assert.equal(npcAt(c.chat, 0, [HESK], 'hesk').body, 'a towering woman');
    renderPatchCards();
    byText(doc, '.worldscrawl_card_btn', 'Undo').click();
    await flush();
    assert.equal(owners(c.chat).some(s => s.owner === 'ot'), false);
    assert.equal(npcAt(c.chat, 0, [HESK], 'hesk').body, 'sturdy');
    await scene.ensureAppearanceRebuilds(0, { ids: ['hesk'], timeout: 50 });
    assert.equal(owners(c.chat).some(s => s.owner === 'ot'), false);
    assert.equal(cacheRows(c.chat), false);
    assert.equal(prompts.filter(p => !/Looks line/.test(p)).length, 0, 'undo does not ask for fields again');
});

test('the found row Turn off and Undo go through the chat card', async () => {
    const { c } = boot();
    c.chat = [msg([])];
    scene.addNpcStamp(c.chat[0], { type: 'npc_found', id: 'hesk', where: 'the bar', place: 'riverton:drowned_rat/bar' });
    const found = c.chat[0].extra[NPC_KEY].find(s => s.type === 'npc_found');
    const doc = makeDoc();
    globalThis.document = doc;
    renderPatchCards();
    const row = doc.querySelector('.worldscrawl_found');
    assert.ok(row);
    assert.ok(buttons(row).includes('Turn off'));
    assert.ok(buttons(row).includes('Undo'));
    assert.equal(buttons(row).includes('Approve'), false);
    byText(row, '.worldscrawl_card_btn', 'Turn off').click();
    await flush();
    assert.equal(found.off, true);
    renderPatchCards();
    const again = doc.querySelector('.worldscrawl_found');
    byText(again, '.worldscrawl_card_btn', 'Undo').click();
    await flush();
    assert.equal((c.chat[0].extra[NPC_KEY] ?? []).some(s => s.type === 'npc_found'), false);
});

test('automatic rows have Turn off and Undo and no appearance approval', async () => {
    const { c } = boot();
    c.chat = [msg([])];
    for (const s of [
        { type: 'npc_memory', id: 'hesk', note: 'she promised a room' },
        { type: 'npc_follow', id: 'hesk', who: 'player' },
        { type: 'npc_disposition', id: 'hesk', who: 'player', value: 'friendly', reason: 'a kind word' },
        { type: 'npc_name', id: 'hesk', who: 'player' },
        { type: 'npc_rel', id: 'hesk', who: 'player', state: 'met' },
        { type: 'npc_schedule', id: 'hesk', schedule: [{ activity: 'tending bar' }] },
        { type: 'npc_fact', id: 'hesk', field: 'fact', text: 'owes a favor' },
    ]) scene.addNpcStamp(c.chat[0], s);
    const doc = makeDoc();
    globalThis.document = doc;
    renderPatchCards();
    const lines = doc.querySelectorAll('.worldscrawl_npcchange');
    assert.equal(lines.length, 7);
    for (const line of lines) {
        const labels = buttons(line);
        assert.ok(labels.includes('Turn off'), line.textContent);
        assert.ok(labels.includes('Undo'), line.textContent);
        assert.equal(labels.includes('Approve'), false, line.textContent);
    }
    assert.equal(doc.querySelectorAll('.worldscrawl_card_btn').some(b => b.textContent === 'Update'), false);
    const memory = c.chat[0].extra[NPC_KEY].find(s => s.type === 'npc_memory');
    const memoryLine = lines.find(el => el.textContent.includes('promised a room'));
    byText(memoryLine, '.worldscrawl_card_btn', 'Turn off').click();
    await flush();
    assert.equal(memory.off, true);
    assert.equal(npcAt(c.chat, 0, [HESK], 'hesk').memory.includes('she promised a room'), false);
});

test('GUI Changes Turn off is the map channel, and a place Undo cannot remove a person', async () => {
    const { c } = boot();
    const o = commit(appearance({ intent: 'taller', fields: 'body', layer: { body: 'a towering woman' }, owner: 'ogui' }));
    c.chat = [msg([o])];
    Chan.all = [];
    globalThis.BroadcastChannel = Chan;
    openMapChannel();
    const gui = new Chan('worldscrawl');
    const doc = makeDoc();
    const env = { exists: () => true, relocate: {}, names: a => a, playerAt: () => '', clock: () => ({ elapsed: 0, day: 1, hour: 8, minute: 0, minutes: 480 }) };
    const panel = castPanel(doc, {
        load: async () => ({ npcs: [HESK] }),
        outline: async () => null,
        play: () => npcPlayState(c.chat, [HESK], env),
        decideNpc: spec => askGui(gui, 'npc_decide', { chatId: 'c1', ...spec }),
        chatAt: () => ({ msg: 0, swipe: 0 }),
        placeName: a => a,
    });
    await panel.refresh();
    panel.selectId('hesk', 'changes');
    const card = panel.el.querySelector('.cast-card');
    assert.ok(card && !card.open, 'collapsed by default');
    const off = byText(card, '.worldscrawl_card_btn', 'Turn off');
    const undo = byText(card, '.worldscrawl_card_btn', 'Undo');
    assert.ok(off);
    assert.ok(undo);
    assert.deepEqual(buttons(card), ['Edit', 'Turn off', 'Undo'], 'the chat card\'s kept buttons');
    off.click();
    await flush();
    assert.equal(o.off, true);
    assert.equal(npcAt(c.chat, 0, [HESK], 'hesk').body, 'sturdy');
    gui.postMessage({ type: 'remove_change', chatId: 'c1', req: 4, msg: 0, id: o.identity.owner });
    await flush();
    assert.equal(owners(c.chat).some(s => s.owner === 'ogui'), true);
});

test('Approve on the chat card wins, and a later Discard from the channel is stale', async () => {
    const { c, prompts } = boot();
    const o = appearance({ intent: 'taller', fields: 'body', layer: { body: 'a towering woman' }, owner: 'orace' });
    c.chat = [msg([o])];
    const filled = await scene.fillCandidate(c.chat, o.identity, { baseline: { body: 'sturdy', outfit: 'wool' }, name: 'Hesk', elapsed: 0 });
    assert.equal(filled.ok, true, filled.error);
    assert.equal(prompts.length, 0);
    const rev = o.decisionRev;
    const token = o.candidate.token;
    Chan.all = [];
    globalThis.BroadcastChannel = Chan;
    openMapChannel();
    const gui = new Chan('worldscrawl');
    const doc = makeDoc();
    globalThis.document = doc;
    renderPatchCards();
    byText(doc, '.worldscrawl_card_btn', 'Approve').click();
    await flush();
    gui.postMessage({ type: 'npc_decide', chatId: 'c1', req: 9, identity: o.identity, decisionRev: rev, action: 'discard', payload: {} });
    await flush();
    assert.equal(o.committed?.layer?.body, 'a towering woman');
    assert.equal(o.candidate, null);
    assert.equal(o.decisionRev, rev + 1);
    assert.equal(prompts.filter(p => !/Looks line/.test(p)).length, 0, 'approve of the reviewed fields does not ask for fields');
    assert.equal(prompts.filter(p => /Looks line/.test(p)).length, 1, 'a real field change asks for Looks once');
    const again = await scene.settleNpc(c.chat, o.identity, rev, 'approve', { token, elapsed: 0 });
    assert.equal(again.stale, true);
    assert.equal(o.committed.layer.body, 'a towering woman');
});

test('both expiry orders settle on the turn rebuild, including an earlier temp while a later one remains', async () => {
    await loadCalendar();
    const { c, prompts } = boot();
    const early = commit(appearance({ intent: 'gnoll', fields: 'body', layer: { body: 'a gnoll frame' }, lasts: 120, start: 0, owner: 'early' }));
    const late = commit(appearance({ intent: 'centaur', fields: 'body', layer: { body: 'a centaur barrel' }, lasts: 60, start: 0, owner: 'late' }));
    c.chat = [msg([early, late]), { mes: 'An hour later.', is_user: false, swipe_id: 0, extra: { worldscrawl_wait: { seconds: 3600 } } }];
    const blank = npcAt(c.chat, 0, [HESK], 'hesk', i => ({ elapsed: i === 0 ? 0 : 3600 }));
    assert.equal(blank.body, '', 'the overlap is unresolved until a production rebuild');
    c.generateRaw = async (args) => { prompts.push(String(args.prompt)); return String(args.prompt).includes('Looks') ? '{"looks":"a gnoll with copper braids"}' : '{"body":"should not be asked","outfit":"wool"}'; };
    await scene.ensureAppearanceRebuilds(1, { ids: ['hesk'], timeout: 80 });
    const hour = npcAt(c.chat, 1, [HESK], 'hesk', () => ({ elapsed: 3600 }));
    assert.equal(hour.body, 'a gnoll frame');
    assert.equal(prompts.some(p => /should not be asked|Rewrite/.test(p) && !/Looks/.test(p)), false);
    assert.equal(cacheRows(c.chat), false);
    c.chat = [msg([
        commit(appearance({ intent: 'first', fields: 'body', layer: { body: 'the earlier frame' }, lasts: 60, start: 0, owner: 'e2' })),
        commit(appearance({ intent: 'second', fields: 'outfit', layer: { outfit: 'a later cloak' }, lasts: 120, start: 0, owner: 'l2' })),
    ]), { mes: 'An hour later.', is_user: false, swipe_id: 0, extra: { worldscrawl_wait: { seconds: 3600 } } }];
    prompts.length = 0;
    await scene.ensureAppearanceRebuilds(1, { ids: ['hesk'], timeout: 80 });
    const kept = npcAt(c.chat, 1, [HESK], 'hesk', () => ({ elapsed: 3600 }));
    assert.equal(kept.body, 'sturdy');
    assert.equal(kept.outfit, 'a later cloak');
    assert.equal(prompts.filter(p => !/Looks/.test(p)).length, 0);
});

test('Undo of an earlier lasting owner recomputes, and export is the lasting result that remains', async () => {
    const { c } = boot();
    const early = commit(appearance({ intent: 'taller', fields: 'body', layer: { body: 'a towering woman' }, owner: 'ear' }));
    const later = commit(appearance({ intent: 'cloak', fields: 'outfit', layer: { outfit: 'a red cloak' }, owner: 'lat' }));
    c.chat = [msg([early, later])];
    const posts = [];
    globalThis.fetch = async (url, opts) => {
        posts.push({ url: String(url), body: opts?.body ? JSON.parse(opts.body) : null });
        return { ok: true, status: 200, headers: { get: () => '' }, json: async () => (String(url).includes('/worlds') ? { default: 'riverton', worlds: [{ id: 'riverton', name: 'Riverton', cast: [HESK] }] } : { id: 'hesk', file: 'hesk.json', updated: true }) };
    };
    const first = await scene.exportNpc('hesk', { update: true });
    assert.equal(first.ok, true, first?.error);
    const sent = () => posts.filter(p => p.body?.npc).at(-1).body.npc;
    assert.equal(sent().appearance.body, 'a towering woman');
    assert.equal(sent().appearance.outfit, 'a red cloak');
    const undone = await scene.settleNpc(c.chat, early.identity, early.decisionRev, 'undo', {});
    assert.equal(undone.ok, true);
    const second = await scene.exportNpc('hesk', { update: true });
    assert.equal(second.ok, true, second?.error);
    assert.equal(sent().appearance.body, 'sturdy');
    assert.equal(sent().appearance.outfit, 'a red cloak');
    assert.equal(posts.filter(p => p.body?.npc).map(p => p.body.npc.appearance.body).filter(b => b === 'a towering woman').length, 1);
    assert.equal(c.chat[0].extra.worldscrawl_npc_baseline.hesk.body, 'sturdy');
    assert.equal(owners(c.chat).some(s => s.owner === 'ear'), false);
    assert.equal(owners(c.chat).some(s => s.owner === 'lat'), true);
});

test('a baseline edit under a lasting owner and a temp is one lasting step, and export omits the temp', async () => {
    await loadCalendar();
    const { c, prompts } = boot();
    const lasting = commit(appearance({ intent: 'cloak', fields: 'outfit', layer: { outfit: 'a red cloak' }, owner: 'last' }));
    const temp = commit(appearance({ intent: 'sweaty', fields: 'body', layer: { body: 'a sweaty frame' }, lasts: 60, start: 0, owner: 'tmp' }));
    c.chat = [msg([lasting, temp])];
    c.generateRaw = async (args) => { prompts.push(String(args.prompt)); return '{"body":"broader shoulders, sweaty","outfit":"a red cloak"}'; };
    const edited = await scene.npcChatEdit({ chatId: 'c1', msg: 0, swipe: 0, id: 'hesk', stamps: [{ type: 'npc_baseline', field: 'body', text: 'broader shoulders' }] });
    assert.equal(edited.ok, true, edited.error);
    const proposal = owners(c.chat).find(s => s.type === 'npc_baseline');
    assert.equal(proposal.committed, null);
    assert.equal(proposal.start, 0);
    assert.equal(proposal.candidate.lastingBefore.outfit, 'a red cloak');
    assert.equal(proposal.candidate.lastingBefore.body, 'sturdy');
    assert.equal(proposal.candidate.lastingPreview.body, 'broader shoulders');
    assert.equal(proposal.candidate.lastingPreview.outfit, 'a red cloak');
    const started = proposal.start;
    const approved = await scene.settleNpc(c.chat, proposal.identity, proposal.decisionRev, 'approve', { token: proposal.candidate.token, elapsed: 0 });
    assert.equal(approved.ok, true, approved.error);
    assert.equal(proposal.start, started);
    assert.equal(prompts.filter(p => /Rewrite body/.test(p)).length, 1, prompts.map(p => p.slice(0, 40)).join(' || '));
    const live = npcAt(c.chat, 0, [HESK], 'hesk', () => ({ elapsed: 0 }));
    assert.equal(live.lasting.body, 'broader shoulders');
    assert.equal(live.outfit, 'a red cloak');
    assert.equal(live.pinned.body, 'sturdy');
    assert.equal(claimResult(live, temp), 'landed');
    c.chat.push({ mes: 'An hour later.', is_user: false, swipe_id: 0, extra: { worldscrawl_wait: { seconds: 3600 } } });
    const after = npcAt(c.chat, 1, [HESK], 'hesk', i => ({ elapsed: i === 0 ? 0 : 3600 }));
    assert.equal(after.body, 'broader shoulders');
    assert.equal(after.outfit, 'a red cloak');
    const posts = [];
    globalThis.fetch = async (url, opts) => {
        posts.push(opts?.body ? JSON.parse(opts.body) : null);
        return { ok: true, status: 200, headers: { get: () => '' }, json: async () => ({ id: 'hesk', file: 'hesk.json', updated: true, default: 'riverton', worlds: [{ id: 'riverton', cast: [HESK] }] }) };
    };
    const exported = await scene.exportNpc('hesk', { update: true });
    assert.equal(exported.ok, true, exported?.error);
    const sentNpc = () => posts.filter(p => p?.npc).at(-1).npc;
    assert.equal(sentNpc().appearance.body, 'broader shoulders');
    assert.equal(sentNpc().appearance.outfit, 'a red cloak');
    assert.equal(JSON.stringify(sentNpc()).includes('sweaty'), false);
    assert.equal(c.chat[0].extra.worldscrawl_npc_baseline.hesk.body, 'sturdy');
});

test('malformed, refusal, truncated, partial, empty, and timeout store no fields', async () => {
    const cases = [
        ['malformed', 'hello there'],
        ['refusal', 'I cannot rewrite that'],
        ['truncated', '{"body":"cut"'],
        ['partial', '{"outfit":"only an outfit"}'], // body was asked; outfit alone is not the asked field
        ['empty', ''],
    ];
    for (const [kind, raw] of cases) {
        const { c } = boot();
        const a = commit(appearance({ intent: 'gnoll', fields: 'body', layer: {}, owner: `a_${kind}` }));
        const b = commit(appearance({ intent: 'scarred', fields: 'body', layer: {}, owner: `b_${kind}` }));
        c.chat = [msg([a, b])];
        c.generateRaw = async () => raw;
        await scene.ensureAppearanceRebuilds(0, { ids: ['hesk'], timeout: 50 });
        const play = npcAt(c.chat, 0, [HESK], 'hesk', () => ({ elapsed: 0 }));
        assert.equal(play.body, '', kind);
        assert.equal((c.chat[0].extra.worldscrawl_compose?.records ?? []).some(r => r.kind === 'fields'), false, kind);
        assert.equal(scene.appearJobs(c.chat[0]).some(j => j.part === 'fields' && j.kind === kind), true, kind);
        assert.equal(cacheRows(c.chat), false, kind);
    }
    const { c } = boot();
    const a = commit(appearance({ intent: 'gnoll', fields: 'body', layer: {}, owner: 'ta' }));
    const b = commit(appearance({ intent: 'scarred', fields: 'body', layer: {}, owner: 'tb' }));
    c.chat = [msg([a, b])];
    c.generateRaw = () => new Promise(() => {});
    await scene.ensureAppearanceRebuilds(0, { ids: ['hesk'], timeout: 20 });
    assert.equal(npcAt(c.chat, 0, [HESK], 'hesk', () => ({ elapsed: 0 })).body, '');
    assert.equal(scene.appearJobs(c.chat[0]).some(j => j.kind === 'timeout'), true);
    assert.equal(c.chat[0].extra.worldscrawl_compose, undefined);
});

test('a late completion after discard or a swipe is not stored, and a failed edit leaves committed', async () => {
    const { c } = boot();
    const o = commit(appearance({ intent: 'old', fields: 'body', layer: { body: 'original edit' }, owner: 'oled' }));
    o.candidate = { token: 't0', epoch: 0, proposedLasts: null, kind: 'appearance', intent: 'new', fields: 'body,outfit', layer: {}, phase: 'working' };
    c.chat = [msg([o])];
    let release;
    c.generateRaw = () => new Promise(r => { release = r; });
    const pending = scene.fillCandidate(c.chat, o.identity, { baseline: { body: 'sturdy', outfit: 'wool' }, name: 'Hesk', elapsed: 0, timeout: 200 });
    await flush();
    const discarded = await scene.settleNpc(c.chat, o.identity, o.decisionRev, 'discard', {});
    assert.equal(discarded.ok, true);
    release('{"body":"late body","outfit":"late cloak"}');
    const late = await pending;
    assert.equal(late.stale, true);
    assert.equal(o.committed.layer.body, 'original edit');
    assert.equal(o.candidate, null);
    assert.equal(JSON.stringify(c.chat[0].extra.worldscrawl_compose ?? {}).includes('late body'), false);

    o.candidate = { token: 't1', epoch: 0, proposedLasts: null, kind: 'appearance', intent: 'new', fields: 'body,outfit', layer: {}, phase: 'working' };
    o.decisionRev = discarded.rev;
    let release2;
    c.generateRaw = () => new Promise(r => { release2 = r; });
    const pending2 = scene.fillCandidate(c.chat, o.identity, { baseline: { body: 'sturdy', outfit: 'wool' }, name: 'Hesk', elapsed: 0, timeout: 200 });
    await flush();
    invalidateAppearance(c.chat[0]);
    release2('{"body":"swiped body","outfit":"wool"}');
    const swiped = await pending2;
    assert.equal(swiped.stale, true);
    assert.equal(o.committed.layer.body, 'original edit');
    assert.equal(JSON.stringify(c.chat[0].extra.worldscrawl_compose ?? {}).includes('swiped body'), false);

    const edited = scene.decideNpc(c.chat, o.identity, o.decisionRev, 'edit', { intent: 'cropped', fields: 'body,outfit', layer: {} });
    c.generateRaw = async () => 'not json at all';
    const failed = await scene.fillCandidate(c.chat, o.identity, { baseline: { body: 'sturdy', outfit: 'wool' }, name: 'Hesk', elapsed: 0, timeout: 50 });
    assert.equal(edited.refill, true);
    assert.equal(failed.ok, false);
    assert.equal(o.committed.layer.body, 'original edit');
    assert.equal(o.candidate.phase, 'failed');
    const denied = scene.decideNpc(c.chat, o.identity, o.decisionRev, 'approve', { token: o.candidate.token, elapsed: 0 });
    assert.equal(denied.ok, false);
    assert.equal(o.committed.layer.body, 'original edit');
});

test('start is assigned on the uncommitted proposal and approval does not move it', async () => {
    const { c } = boot();
    c.chat = [msg([])];
    const res = await scene.npcChatEdit({ chatId: 'c1', msg: 0, swipe: 0, id: 'hesk', stamps: [{ type: 'npc_baseline', field: 'outfit', text: 'a linen apron' }] });
    assert.equal(res.ok, true, res.error);
    const o = owners(c.chat)[0];
    assert.equal(o.committed, null);
    assert.equal(typeof o.start, 'number');
    const started = o.start;
    scene.decideNpc(c.chat, o.identity, o.decisionRev, 'edit', { text: 'a linen apron', lasts: 15 });
    assert.equal(o.start, started);
    const filled = await scene.fillCandidate(c.chat, o.identity, { baseline: o.candidate ? { body: 'sturdy', outfit: 'wool' } : { body: 'sturdy', outfit: 'wool' }, name: 'Hesk', elapsed: started });
    assert.equal(filled.ok, true, filled.error);
    assert.equal(o.start, started);
    const approved = await scene.settleNpc(c.chat, o.identity, o.decisionRev, 'approve', { token: o.candidate.token, elapsed: started });
    assert.equal(approved.ok, true, approved.error);
    assert.equal(o.start, started);
    o.candidate = { token: 'expired', epoch: 0, proposedLasts: 1, kind: 'baseline', field: 'outfit', text: 'a linen apron', phase: 'review', lastingPreview: { body: 'sturdy', outfit: 'a linen apron' }, livePreview: { body: 'sturdy', outfit: 'a linen apron' }, lastingKey: 'k', liveKey: 'k' };
    const late = await scene.settleNpc(c.chat, o.identity, o.decisionRev, 'approve', { token: 'expired', elapsed: started + 120 });
    assert.equal(late.ok, false);
    assert.equal(o.start, started);
    assert.equal(o.committed.text, 'a linen apron');
});

test('turning an unknown overlap off settles the survivor without a direct recompose call', async () => {
    const { c, prompts } = boot();
    const a = commit(appearance({ intent: 'gnoll', fields: 'body', layer: { body: 'a gnoll frame' }, owner: 'ga' }));
    const b = commit(appearance({ intent: 'centaur', fields: 'body', layer: { body: 'a centaur barrel' }, owner: 'gb' }));
    c.chat = [msg([a, b])];
    assert.equal(npcAt(c.chat, 0, [HESK], 'hesk', () => ({ elapsed: 0 })).body, '');
    c.generateRaw = async (args) => { prompts.push(String(args.prompt)); return '{"body":"should not run","outfit":"wool"}'; };
    const doc = makeDoc();
    globalThis.document = doc;
    renderPatchCards();
    const line = doc.querySelectorAll('.worldscrawl_npcchange').find(el => el.textContent.includes('gnoll'));
    byText(line, '.worldscrawl_card_btn', 'Turn off').click();
    await flush();
    const play = npcAt(c.chat, 0, [HESK], 'hesk', () => ({ elapsed: 0 }));
    assert.equal(play.body, 'a centaur barrel');
    assert.equal(prompts.filter(p => /Rewrite body/.test(p)).length, 0);
    assert.equal(cacheRows(c.chat), false);
});

test('an unknown pair is settled by the turn rebuild, and a removed owner is not an input', async () => {
    const { c, prompts } = boot();
    const a = commit(appearance({ intent: 'gnoll', fields: 'body', layer: {}, owner: 'ua' }));
    const b = commit(appearance({ intent: 'scarred', fields: 'body', layer: {}, owner: 'ub' }));
    c.chat = [msg([a, b])];
    c.generateRaw = async (args) => {
        prompts.push(String(args.prompt));
        return String(args.prompt).includes('Looks') ? '{"looks":"marked copper braids"}' : '{"body":"a gnoll frame, scarred","outfit":"wool"}';
    };
    await scene.ensureAppearanceRebuilds(0, { ids: ['hesk'], timeout: 80 });
    assert.equal(npcAt(c.chat, 0, [HESK], 'hesk', () => ({ elapsed: 0 })).body, 'a gnoll frame, scarred');
    assert.equal(owners(c.chat).length, 2);
    prompts.length = 0;
    const undone = await scene.settleNpc(c.chat, a.identity, a.decisionRev, 'undo', {});
    assert.equal(undone.ok, true);
    assert.equal(prompts.some(p => /gnoll/.test(p)), false);
    assert.ok(prompts.some(p => !/Looks/.test(p)), 'the remaining unknown owner is recomposed from the undo');
    assert.equal(owners(c.chat).some(s => s.owner === 'ua'), false);
    assert.equal(owners(c.chat).length, 1);
    assert.equal(cacheRows(c.chat), false);
});

test('a Looks failure leaves the fields, hides the old line, and export omits Looks', async () => {
    const { c, prompts } = boot();
    const o = commit(appearance({ intent: 'taller', fields: 'body', layer: { body: 'a towering woman' }, owner: 'lk' }));
    c.chat = [msg([o])];
    c.generateRaw = async (args) => { prompts.push(String(args.prompt)); return 'I cannot write that'; };
    await scene.ensureAppearanceRebuilds(0, { ids: ['hesk'], timeout: 40 });
    const play = npcAt(c.chat, 0, [HESK], 'hesk', () => ({ elapsed: 0 }));
    assert.equal(play.body, 'a towering woman');
    assert.equal(play.looks, '');
    assert.notEqual(play.looks, 'copper braids');
    assert.ok(prompts.every(p => /Looks/.test(p)));
    assert.equal(scene.appearJobs(c.chat[0]).some(j => j.part === 'looks' && j.status === 'failed'), true);
    assert.equal((c.chat[0].extra.worldscrawl_compose?.records ?? []).some(r => r.kind === 'fields' && r.body === 'a towering woman'), true);
    let posted = false;
    globalThis.fetch = async (url, opts) => {
        posted = true;
        const body = opts?.body ? JSON.parse(opts.body) : null;
        assert.equal(body?.npc?.appearance?.body, 'a towering woman');
        assert.equal(body?.npc?.appearance?.summary, undefined);
        return { ok: true, status: 200, headers: { get: () => '' }, json: async () => ({ id: 'hesk', file: 'hesk.json', updated: true }) };
    };
    const exported = await scene.exportNpc('hesk', { update: true });
    assert.equal(exported.ok, true, exported?.error);
    assert.equal(posted, true);
    const blocked = commit(appearance({ intent: 'other', fields: 'body', layer: {}, owner: 'bad' }));
    c.chat[0].extra[NPC_KEY].push(blocked);
    posted = false;
    const refused = await scene.exportNpc('hesk', { update: true });
    assert.equal(refused.ok, false);
    assert.match(refused.error, /unresolved/);
    assert.equal(posted, false);
});

test('the same semantic result is reused from another message and ignored on the wrong swipe', async () => {
    const { c, prompts } = boot();
    const a = commit(appearance({ intent: 'gnoll', fields: 'body', layer: {}, owner: 'ca' }));
    const b = commit(appearance({ intent: 'scarred', fields: 'body', layer: {}, owner: 'cb' }));
    const first = msg([a, b]);
    c.chat = [first];
    c.generateRaw = async (args) => {
        prompts.push(String(args.prompt));
        return String(args.prompt).includes('Looks') ? '{"looks":"a scarred gnoll"}' : '{"body":"a stored frame","outfit":"wool"}';
    };
    await scene.ensureAppearanceRebuilds(0, { ids: ['hesk'], timeout: 80 });
    assert.equal(prompts.filter(p => !/Looks/.test(p)).length, 1);
    const movedA = { ...a, owner: 'ca2', identity: { ...a.identity, owner: 'ca2', message: 'm2' } };
    const movedB = { ...b, owner: 'cb2', identity: { ...b.identity, owner: 'cb2', message: 'm2' } };
    first.extra[NPC_KEY] = [];
    const second = { mes: 'later', is_user: false, swipe_id: 0, extra: { worldscrawl_mid: 'm2', [NPC_KEY]: [movedA, movedB] } };
    c.chat = [first, second];
    prompts.length = 0;
    await scene.ensureAppearanceRebuilds(1, { ids: ['hesk'], timeout: 80 });
    assert.equal(prompts.length, 0);
    assert.equal(npcAt(c.chat, 1, [HESK], 'hesk', () => ({ elapsed: 0 })).body, 'a stored frame');
    first.extra.worldscrawl_compose = { ...first.extra.worldscrawl_compose, swipe: 1 };
    prompts.length = 0;
    c.generateRaw = async (args) => { prompts.push(String(args.prompt)); return String(args.prompt).includes('Looks') ? '{"looks":"other"}' : '{"body":"a fresh frame","outfit":"wool"}'; };
    await scene.ensureAppearanceRebuilds(1, { ids: ['hesk'], timeout: 80 });
    assert.ok(prompts.some(p => !/Looks/.test(p)));
    assert.equal(npcAt(c.chat, 1, [HESK], 'hesk', () => ({ elapsed: 0 })).body, 'a fresh frame');
});

test('reload replays the pin and the compose record, and update then undo exports each lasting op once', async () => {
    const { c } = boot();
    const body = commit(appearance({ intent: 'broader', fields: 'body', layer: { body: 'broader shoulders' }, owner: 'bd' }));
    const outfit = commit(appearance({ intent: 'cloak', fields: 'outfit', layer: { outfit: 'a red cloak' }, owner: 'cl' }));
    c.chat = [msg([body, outfit])];
    npcAt(c.chat, 0, [HESK], 'hesk', () => ({ elapsed: 0 }));
    const saved = JSON.parse(JSON.stringify(c.chat));
    c.chat = saved;
    const reloaded = npcAt(c.chat, 0, [HESK], 'hesk', () => ({ elapsed: 0 }));
    assert.equal(reloaded.body, 'broader shoulders');
    assert.equal(reloaded.outfit, 'a red cloak');
    assert.equal(reloaded.pinned.body, 'sturdy');
    assert.equal(reloaded.pinned.outfit, 'wool');
    const posts = [];
    globalThis.fetch = async (url, opts) => {
        posts.push(opts?.body ? JSON.parse(opts.body) : null);
        return { ok: true, status: 200, headers: { get: () => '' }, json: async () => (String(url).includes('/worlds') ? { default: 'riverton', worlds: [{ id: 'riverton', cast: [HESK] }] } : { id: 'hesk', file: 'hesk.json', updated: true }) };
    };
    assert.equal((await scene.exportNpc('hesk', { update: true })).ok, true);
    const sentNpc = () => posts.filter(p => p?.npc).at(-1).npc;
    assert.equal(sentNpc().appearance.body, 'broader shoulders');
    assert.equal(sentNpc().appearance.outfit, 'a red cloak');
    c.chat = JSON.parse(JSON.stringify(saved));
    const kept = c.chat[0].extra[NPC_KEY].find(s => s.owner === 'bd');
    assert.equal((await scene.settleNpc(c.chat, kept.identity, kept.decisionRev, 'undo', {})).ok, true);
    assert.equal((await scene.exportNpc('hesk', { update: true })).ok, true);
    const exported = posts.filter(p => p?.npc);
    assert.equal(exported[0].npc.appearance.body, 'broader shoulders');
    assert.equal(exported[1].npc.appearance.body, 'sturdy');
    assert.equal(exported[1].npc.appearance.outfit, 'a red cloak');
    assert.equal(exported.filter(p => p.npc.appearance.body === 'broader shoulders').length, 1);
    assert.equal(c.chat[0].extra.worldscrawl_npc_baseline.hesk.body, 'sturdy');
});

test('a tracker appearance waits for approval, and a place answer does not write a person', async () => {
    const { c, prompts } = boot();
    c.chat = [msg([])];
    c.generateRaw = async () => { prompts.push('tracker'); return '{"body":"no","outfit":"no"}'; };
    const { applyTrackerResult } = await import('../../extension/discovery.mjs');
    await applyTrackerResult(0, { place: null, wait: null, people: [{ id: 'hesk', action: 'memory', text: 'Mara promised the cellar key.' }, { id: 'hesk', action: 'appearance', intent: 'taller', fields: 'body', body: 'a towering woman', lasts: '2 hours' }] });
    const appearanceStamp = (c.chat[0].extra[NPC_KEY] ?? []).find(s => s.type === 'npc_appearance');
    const memory = (c.chat[0].extra[NPC_KEY] ?? []).find(s => s.type === 'npc_memory');
    assert.ok(memory);
    assert.equal(memory.candidate, undefined);
    assert.equal(appearanceStamp.committed, null);
    assert.equal(typeof appearanceStamp.start, 'number');
    assert.equal(npcAt(c.chat, 0, [HESK], 'hesk').body, 'sturdy');
    assert.equal(prompts.length, 0);
    const ans = readChangeAnswer({ ops: [{ op: 'rename_room', room: 'riverton:drowned_rat/bar', name: 'The New Bar' }, { op: 'npc_appearance', id: 'hesk', intent: 'taller' }], people: [{ id: 'hesk', action: 'memory' }] });
    assert.equal(ans.ops.some(o => o.op === 'npc_appearance'), false);
    assert.ok(ans.personClaims.some(p => p.id === 'hesk'));
    assert.equal((c.chat[0].extra[NPC_KEY] ?? []).some(s => s.intent === 'taller' && s.committed), false);
});

test('off then on reuses the stored combination, and a failed lasting export stays blocked', async () => {
    const { c, prompts } = boot();
    const a = commit(appearance({ intent: 'gnoll', fields: 'body', layer: {}, owner: 'ra' }));
    const b = commit(appearance({ intent: 'scarred', fields: 'body', layer: {}, owner: 'rb' }));
    c.chat = [msg([a, b])];
    c.generateRaw = async (args) => { prompts.push(String(args.prompt)); return String(args.prompt).includes('Looks') ? '{"looks":"scarred braids"}' : '{"body":"a stored gnoll","outfit":"wool"}'; };
    await scene.ensureAppearanceRebuilds(0, { ids: ['hesk'], timeout: 80 });
    const off = await scene.settleNpc(c.chat, a.identity, a.decisionRev, 'off', {});
    const fields = () => prompts.filter(p => !/Looks/.test(p)).length;
    const mid = fields();
    await scene.settleNpc(c.chat, a.identity, off.rev, 'on', {});
    assert.equal(fields(), mid, 'turning the same combination back on reuses the stored fields');
    assert.equal(npcAt(c.chat, 0, [HESK], 'hesk', () => ({ elapsed: 0 })).body, 'a stored gnoll');
    let calls = 0;
    globalThis.fetch = async () => { calls++; return { ok: true, status: 200, headers: { get: () => '' }, json: async () => ({}) }; };
    c.chat[0].extra.worldscrawl_compose = { swipe: 0, records: [] };
    const blocked = await scene.exportNpc('hesk');
    assert.equal(blocked.ok, false);
    assert.equal(calls, 0);
});

test('a later message on its own swipe keeps an earlier message\'s owners and result', async () => {
    const { c, prompts } = boot();
    const a = commit(appearance({ intent: 'gnoll', fields: 'body', layer: {}, owner: 'sw0' }));
    const b = commit(appearance({ intent: 'scarred', fields: 'body', layer: {}, owner: 'sw1' }));
    const early = msg([a, b]);
    early.swipe_id = 0;
    early.swipe_info = [{ extra: {} }, { extra: {} }];
    c.chat = [early];
    c.generateRaw = async (args) => { prompts.push(String(args.prompt)); return /Looks line/.test(String(args.prompt)) ? '{"looks":"a stored gnoll"}' : '{"body":"a stored frame","outfit":"wool"}'; };
    await scene.ensureAppearanceRebuilds(0, { ids: ['hesk'], timeout: 80 });
    assert.equal(npcAt(c.chat, 0, [HESK], 'hesk', () => ({ elapsed: 0 })).body, 'a stored frame');
    syncSwipeExtra(early);
    c.chat.push({ mes: 'Another swipe of a later reply.', is_user: false, swipe_id: 1, swipe_info: [{ extra: {} }, { extra: {} }], extra: {} });
    const kept = npcAt(c.chat, 1, [HESK], 'hesk', () => ({ elapsed: 0 }));
    assert.equal(kept.body, 'a stored frame');
    assert.equal(kept.liveOps.some(o => o.owner === 'sw0'), true);
    early.swipe_id = 1;
    const hidden = npcAt(c.chat, 1, [HESK], 'hesk', () => ({ elapsed: 0 }));
    assert.equal(hidden.body, 'sturdy');
    assert.equal(hidden.liveOps.some(o => o.owner === 'sw0'), false);
    const saved = JSON.parse(JSON.stringify(c.chat));
    saved[0].swipe_id = 0;
    saved[0].extra = JSON.parse(JSON.stringify(saved[0].swipe_info[0].extra));
    const back = npcAt(saved, 1, [HESK], 'hesk', () => ({ elapsed: 0 }));
    assert.equal(back.body, 'a stored frame');
    assert.equal(back.liveOps.map(o => o.owner).sort().join(), 'sw0,sw1');
});

test('the map channel saves, mirrors the swipe, and both surfaces redraw', async () => {
    const { c, prompts } = boot();
    const o = appearance({ intent: 'taller', fields: 'body', layer: { body: 'a towering woman' }, owner: 'gsave' });
    const host = msg([o]);
    host.swipe_info = [{ extra: {} }];
    c.chat = [host];
    let saves = 0;
    c.saveChat = async () => { saves++; };
    await scene.fillCandidate(c.chat, o.identity, { baseline: { body: 'sturdy', outfit: 'wool' }, name: 'Hesk', elapsed: 0 });
    assert.equal(prompts.filter(p => /Rewrite body/.test(p)).length, 0);
    Chan.all = [];
    globalThis.BroadcastChannel = Chan;
    openMapChannel();
    const gui = new Chan('worldscrawl');
    const doc = makeDoc();
    globalThis.document = doc;
    globalThis.getComputedStyle = () => ({ getPropertyValue: () => '', backgroundColor: '' });
    const env = { exists: () => true, relocate: {}, names: a => a, playerAt: () => '', clock: () => ({ elapsed: 0, day: 1, hour: 8, minute: 0, minutes: 480 }) };
    const panel = castPanel(doc, {
        load: async () => ({ npcs: [HESK] }),
        outline: async () => null,
        play: () => npcPlayState(c.chat, [HESK], env),
        decideNpc: spec => askGui(gui, 'npc_decide', { chatId: 'c1', ...spec }),
        chatAt: () => ({ msg: 0, swipe: 0 }),
        placeName: a => a,
    });
    await panel.refresh();
    panel.selectId('hesk', 'changes');
    const approve = byText(panel.el, '.worldscrawl_card_btn', 'Approve');
    assert.ok(approve, panel.el.textContent);
    assert.match(panel.el.textContent, /a towering woman/);
    approve.click();
    await flush();
    assert.ok(saves >= 1);
    assert.equal(o.committed?.layer?.body, 'a towering woman');
    assert.equal(host.swipe_info[0].extra.worldscrawl_npc.some(s => s.committed?.layer?.body === 'a towering woman'), true);
    assert.equal(prompts.filter(p => /Rewrite body/.test(p)).length, 0);
    const reloaded = JSON.parse(JSON.stringify(c.chat));
    c.chat = reloaded;
    renderPatchCards();
    assert.ok(byText(doc, '.worldscrawl_card_btn', 'Turn off'));
    panel.setPlay();
    assert.equal(buttons(panel.el).includes('Approve'), false);
    assert.ok(buttons(panel.el).includes('Turn off'));
});

test('kept change Edit: the review card\'s Body editor; Approve edited saves typed text, and a failed or late Change edit leaves the committed owner', async () => {
    const { c, prompts } = boot();
    const o = commit(appearance({ intent: 'taller', fields: 'body', layer: { body: 'original edit' }, owner: 'ed1' }));
    c.chat = [msg([o])];
    const doc = makeDoc();
    globalThis.document = doc;
    renderPatchCards();
    const row = doc.querySelector('.worldscrawl_npcchange');
    assert.deepEqual(buttons(row), ['Edit', 'Turn off', 'Undo']);
    byText(row, '.worldscrawl_card_btn', 'Edit').click();
    await flush();
    const open = doc.querySelector('.worldscrawl_npcchange');
    assert.deepEqual(buttons(open), ['Close editor', 'Approve edited', 'Turn off', 'Undo']);
    assert.equal(open.querySelectorAll('input').some(b => /Layer/.test(b.placeholder ?? '')), false, 'no layer boxes');
    const boxes = open.querySelectorAll('.worldscrawl_npc_text');
    assert.deepEqual(boxes.map(b => [b.dataset.field, b.value]), [['body', 'original edit']]);
    boxes[0].value = 'a cropped frame';
    boxes[0].dispatchEvent({ type: 'input' });
    byText(open, '.worldscrawl_card_btn', 'Approve edited').click();
    await flush();
    assert.equal(o.candidate, null);
    assert.equal(o.committed.layer.body, 'a cropped frame');
    assert.equal(o.committed.edited, true);
    assert.equal(prompts.filter(p => /Rewrite body/.test(p)).length, 0, 'typed text needs no rewrite call');
    renderPatchCards();
    assert.match(doc.querySelector('.worldscrawl_npcchange').textContent, /Character changed here/);

    // An edited Change line alone asks again; a failed answer leaves the committed text.
    prompts.length = 0;
    c.generateRaw = async () => 'not json';
    byText(doc, '.worldscrawl_card_btn', 'Edit').click();
    await flush();
    const intent = doc.querySelector('.worldscrawl_npc_intent');
    intent.value = 'much taller';
    intent.dispatchEvent({ type: 'input' });
    byText(doc, '.worldscrawl_card_btn', 'Approve edited').click();
    await flush();
    assert.equal(o.committed.layer.body, 'a cropped frame');
    assert.equal(o.candidate.phase, 'failed');

    o.candidate = null;
    let release;
    c.generateRaw = () => new Promise(r => { release = r; });
    renderPatchCards();
    byText(doc, '.worldscrawl_card_btn', 'Edit').click();
    await flush();
    const again = doc.querySelector('.worldscrawl_npc_intent');
    again.value = 'taller still';
    again.dispatchEvent({ type: 'input' });
    byText(doc, '.worldscrawl_card_btn', 'Approve edited').click();
    await flush();
    const dropped = await scene.settleNpc(c.chat, o.identity, o.decisionRev, 'discard', {});
    release('{"body":"late crop","outfit":"wool"}');
    await flush();
    assert.equal(dropped.ok, true);
    assert.equal(o.committed.layer.body, 'a cropped frame');
    assert.equal(JSON.stringify(c.chat[0].extra.worldscrawl_compose ?? {}).includes('late crop'), false);
});

test('Check again uses the current clock, and Approve refuses a review whose inputs moved', async () => {
    await loadCalendar();
    const { c, prompts } = boot();
    const temp = commit(appearance({ intent: 'sweaty', fields: 'outfit', layer: { outfit: 'a soaked cloak' }, lasts: 60, start: 0, owner: 'tmpc' }));
    const proposal = appearance({ intent: 'taller', fields: 'body', layer: { body: 'a towering woman' }, owner: 'propc' });
    c.chat = [msg([temp, proposal]), { mes: 'An hour later.', is_user: false, swipe_id: 0, extra: { worldscrawl_wait: { seconds: 3600 } } }];
    const filled = await scene.fillCandidate(c.chat, proposal.identity, { baseline: { body: 'sturdy', outfit: 'wool' }, name: 'Hesk', elapsed: 0 });
    assert.equal(filled.ok, true, filled.error);
    assert.equal(proposal.candidate.livePreview.outfit, 'a soaked cloak');
    const doc = makeDoc();
    globalThis.document = doc;
    renderPatchCards();
    const before = prompts.filter(p => /Rewrite body/.test(p)).length;
    byText(doc, '.worldscrawl_card_btn', 'Check again').click();
    await flush();
    assert.equal(proposal.candidate.livePreview.outfit, 'wool');
    assert.equal(prompts.filter(p => /Rewrite body/.test(p)).length, before);
    const approved = await scene.settleNpc(c.chat, proposal.identity, proposal.decisionRev, 'approve', { token: proposal.candidate.token, elapsed: 3600 });
    assert.equal(approved.ok, true, approved.error);
    assert.equal(prompts.filter(p => /Rewrite body/.test(p)).length, before);

    const moved = appearance({ intent: 'taller', fields: 'body', layer: { body: 'a towering woman' }, owner: 'moved' });
    c.chat = [msg([moved])];
    await scene.fillCandidate(c.chat, moved.identity, { baseline: { body: 'sturdy', outfit: 'wool' }, name: 'Hesk', elapsed: 0 });
    const underneath = commit(appearance({ intent: 'scar', fields: 'body', layer: { body: 'a scarred frame' }, owner: 'under' }));
    c.chat[0].extra[NPC_KEY].push(underneath);
    prompts.length = 0;
    c.generateRaw = async (args) => { prompts.push(String(args.prompt)); return '{"body":"should not run","outfit":"wool"}'; };
    const refused = await scene.settleNpc(c.chat, moved.identity, moved.decisionRev, 'approve', { token: moved.candidate.token, elapsed: 0 });
    assert.equal(refused.stale, true);
    assert.equal(moved.committed, null);
    assert.equal(moved.candidate.phase, 'review');
    assert.equal(moved.candidate.livePreview.body, 'should not run');
    const wrong = scene.decideNpc(c.chat, { ...moved.identity, domain: 'place' }, moved.decisionRev, 'approve', { token: 'nope', elapsed: 0 });
    assert.equal(wrong.stale, true);
    assert.equal(moved.committed, null);
    const fields = prompts.filter(p => /Rewrite body/.test(p)).length;
    const accepted = await scene.settleNpc(c.chat, moved.identity, moved.decisionRev, 'approve', { token: moved.candidate.token, elapsed: 0 });
    assert.equal(accepted.ok, true, accepted.error);
    assert.equal(moved.committed.layer.body, 'a towering woman');
    assert.equal(prompts.filter(p => /Rewrite body/.test(p)).length, fields);
});

test('a turn refreshes pending appearance with and without a location, and skips a resolved person', async () => {
    const { c, prompts } = boot();
    const bran = { ok: true, id: 'bran', name: 'Bran', line: 'porter', looks: 'grey', body: 'lean', outfit: 'coat', file: 'bran.json' };
    rememberWorlds({ default: 'riverton', worlds: [{ id: 'riverton', name: 'Riverton', cast: [HESK, bran] }] });
    const a = commit(appearance({ intent: 'gnoll', fields: 'body', layer: {}, owner: 'pa' }));
    const b = commit(appearance({ intent: 'scarred', fields: 'body', layer: {}, owner: 'pb' }));
    const user = { mes: 'I look around.', is_user: true, swipe_id: 0, extra: {} };
    c.chat = [msg([a, b]), user];
    c.generateRaw = async (args) => {
        prompts.push(String(args.prompt));
        return /Looks line/.test(String(args.prompt)) ? '{"looks":"a gnoll"}' : '{"body":"a pending frame","outfit":"wool"}';
    };
    globalThis.fetch = async () => { throw new Error('no server'); };
    await scene.prepareNpcs(user);
    assert.ok(prompts.some(p => /Hesk/.test(p) && /Rewrite body/.test(p)));
    assert.equal(prompts.some(p => /Bran/.test(p)), false);
    assert.equal(npcAt(c.chat, 1, [HESK, bran], 'hesk', () => ({ elapsed: 0 })).body, 'a pending frame');
    const asked = prompts.length;
    user.extra.worldscrawl_npc_ready = false;
    c.chat[0].extra[NPC_KEY].push(commit(appearance({ intent: 'third', fields: 'body', layer: {}, owner: 'pc' })));
    globalThis.fetch = async () => ({ ok: true, status: 200, headers: { get: () => '' }, json: async () => ({ address: 'riverton:drowned_rat/bar', name: 'Bar', display_name: 'Bar', description: '', exits: [] }) });
    await scene.prepareNpcs(user);
    assert.ok(prompts.length > asked);
    assert.equal(prompts.some(p => /Bran/.test(p)), false);
});

test('a failed field or Looks job stays failed on the next turn until Retry or the inputs change', async () => {
    const { c, prompts } = boot();
    const a = commit(appearance({ intent: 'gnoll', fields: 'body', layer: {}, owner: 'fa' }));
    const b = commit(appearance({ intent: 'scarred', fields: 'body', layer: {}, owner: 'fb' }));
    const user = { mes: 'I look around.', is_user: true, swipe_id: 0, extra: {} };
    c.chat = [msg([a, b]), user];
    c.generateRaw = async (args) => { prompts.push(String(args.prompt)); return 'not json'; };
    globalThis.fetch = async () => { throw new Error('no server'); };
    await scene.prepareNpcs(user);
    const failed = prompts.length;
    assert.ok(failed >= 2);
    const again = { mes: 'The next turn.', is_user: true, swipe_id: 0, extra: {} };
    c.chat.push(again);
    await scene.prepareNpcs(again);
    assert.equal(prompts.length, failed, 'the next turn does not call the model for the same failed inputs');
    const job = scene.appearJobs(user).find(j => j.part === 'fields' && j.status === 'failed');
    assert.ok(job);
    await scene.retryAppearance(1, 'hesk', job.key);
    assert.ok(prompts.length > failed);

    prompts.length = 0;
    c.chat = [msg([commit(appearance({ intent: 'taller', fields: 'body', layer: { body: 'a towering woman' }, owner: 'lk1' }))])];
    c.chat[0].swipe_id = 0;
    c.generateRaw = async (args) => { prompts.push(String(args.prompt)); return /Looks line/.test(String(args.prompt)) ? 'nope' : '{"body":"a towering woman","outfit":"wool"}'; };
    await scene.ensureAppearanceRebuilds(0);
    const once = prompts.length;
    await scene.ensureAppearanceRebuilds(0);
    assert.equal(prompts.length, once, 'a failed Looks summary is not asked again for the same body and outfit');
    assert.equal(prompts.filter(p => /Rewrite body/.test(p)).length, 0);
    const looks = scene.appearJobs(c.chat[0]).find(j => j.part === 'looks');
    const looksBefore = prompts.filter(p => /Looks line/.test(p)).length;
    await scene.retryAppearance(0, 'hesk', looks.key);
    assert.ok(prompts.filter(p => /Looks line/.test(p)).length > looksBefore);
    assert.equal(prompts.filter(p => /Rewrite body/.test(p)).length, 0);
});

test('the compose record is kept on the swipe that received it', async () => {
    const { c, prompts } = boot();
    const a = commit(appearance({ intent: 'gnoll', fields: 'body', layer: {}, owner: 'ka' }));
    const b = commit(appearance({ intent: 'scarred', fields: 'body', layer: {}, owner: 'kb' }));
    const host = msg([a, b]);
    host.swipe_info = [{ extra: {} }, { extra: {} }];
    c.chat = [host];
    c.generateRaw = async (args) => { prompts.push(String(args.prompt)); return /Looks line/.test(String(args.prompt)) ? '{"looks":"a stored gnoll"}' : '{"body":"a stored frame","outfit":"wool"}'; };
    await scene.ensureAppearanceRebuilds(0);
    assert.equal(host.swipe_info[0].extra.worldscrawl_compose.records.some(r => r.body === 'a stored frame'), true);
    const asked = prompts.length;
    host.swipe_id = 1;
    host.extra = { worldscrawl_mid: host.extra.worldscrawl_mid };
    assert.equal(npcAt(c.chat, 0, [HESK], 'hesk', () => ({ elapsed: 0 })).body, 'sturdy');
    host.swipe_id = 0;
    host.extra = JSON.parse(JSON.stringify(host.swipe_info[0].extra));
    await scene.ensureAppearanceRebuilds(0);
    assert.equal(prompts.length, asked);
    assert.equal(npcAt(c.chat, 0, [HESK], 'hesk', () => ({ elapsed: 0 })).body, 'a stored frame');
});

test('Changes shows the live preview of a temporary candidate, and a clockless Approve stays reviewable', async () => {
    const { c } = boot();
    const proposal = appearance({ intent: 'soaked', fields: 'outfit', layer: { outfit: 'a soaked cloak' }, lasts: 60, start: 0, owner: 'livep' });
    c.chat = [msg([proposal])];
    const filled = await scene.fillCandidate(c.chat, proposal.identity, { baseline: { body: 'sturdy', outfit: 'wool' }, name: 'Hesk', elapsed: 0 });
    assert.equal(filled.ok, true, filled.error);
    assert.equal(proposal.candidate.lastingPreview.outfit, 'wool');
    assert.equal(proposal.candidate.livePreview.outfit, 'a soaked cloak');
    const doc = makeDoc();
    const env = { exists: () => true, relocate: {}, names: a => a, playerAt: () => '', clock: () => ({ elapsed: 0, day: 1, hour: 8, minute: 0, minutes: 480 }) };
    const panel = castPanel(doc, { load: async () => ({ npcs: [HESK] }), outline: async () => null, play: () => npcPlayState(c.chat, [HESK], env), decideNpc: () => {}, placeName: a => a });
    await panel.refresh();
    panel.selectId('hesk', 'changes');
    // Changes shows the same changed-only word diff as the chat card.
    assert.match(panel.el.textContent, /Outfit \(for now\)/);
    assert.match(panel.el.textContent, /a soaked cloak/);
    assert.doesNotMatch(panel.el.textContent, /lasting body|live body|Body \(/);
    assert.ok(panel.el.querySelectorAll('.wsdiff-wins').length >= 1);
    assert.ok(panel.el.querySelectorAll('.wsdiff-wdel').length >= 1);
    const held = scene.decideNpc(c.chat, proposal.identity, proposal.decisionRev, 'approve', { token: proposal.candidate.token });
    assert.match(held.error, /clock/);
    assert.equal(proposal.candidate.phase, 'review');
    assert.equal(proposal.committed, null);
    const recovered = scene.decideNpc(c.chat, proposal.identity, proposal.decisionRev, 'approve', { token: proposal.candidate.token, elapsed: 0 });
    assert.equal(recovered.ok, true, recovered.error);
    assert.equal(proposal.committed.layer.outfit, 'a soaked cloak');
});

test('the tracker picks light or heavy, the rewrite prompt follows it, and the card can switch it', async () => {
    const { c, prompts } = boot();
    c.chat = [msg([])];
    const { applyTrackerResult } = await import('../../extension/discovery.mjs');
    await applyTrackerResult(0, { place: null, wait: null, people: [{ id: 'hesk', action: 'appearance', intent: 'turned into a gnoll', fields: 'body', lasts: '1 hour', scope: 'heavy', why: 'her whole body changed' }] });
    const owner = (c.chat[0].extra[NPC_KEY] ?? []).find(s => s.type === 'npc_appearance');
    assert.equal(owner.candidate.scope, 'heavy');
    assert.equal(owner.candidate.why, 'her whole body changed');
    c.generateRaw = async (args) => { const p = String(args?.prompt ?? ''); prompts.push(p); return /Looks line/.test(p) ? '{"looks":"a gnoll"}' : '{"body":"a furred gnoll","outfit":"wool"}'; };
    const filled = await scene.fillCandidate(c.chat, owner.identity, { baseline: { body: 'sturdy', outfit: 'wool' }, name: 'Hesk', elapsed: 0 });
    assert.equal(filled.ok, true, filled.error);
    assert.match(prompts.at(-1), /turned into a gnoll \[body\] \(full rewrite\)/);
    const doc = makeDoc();
    globalThis.document = doc;
    renderPatchCards();
    const card = doc.querySelector('.worldscrawl_npcpending');
    assert.match(card.textContent, /Full rewrite: her whole body changed/);
    const flip = byText(doc, '.worldscrawl_card_btn', 'Make it a light touch');
    assert.ok(flip, 'the card offers the other scope');
    flip.click();
    await flush();
    assert.equal(owner.candidate.scope, 'light');
    assert.equal(owner.candidate.why, 'set by you');
    assert.match(prompts.at(-1), /turned into a gnoll \[body\] \(light touch\)/);
    assert.equal(owner.candidate.phase, 'review');
    const ok = scene.decideNpc(c.chat, owner.identity, owner.decisionRev, 'approve', { token: owner.candidate.token, elapsed: 0 });
    assert.equal(ok.ok, true, ok.error);
    assert.equal(owner.committed.scope, 'light');
});

test('scope defaults to light, only clear heavy words count, and it is part of the composition key', async () => {
    const { appearanceScope } = await import('../../extension/npceffects.mjs');
    const { contentIdOf } = await import('../../extension/replay.mjs');
    for (const v of [undefined, '', 'light', 'medium', 'nope']) assert.equal(appearanceScope(v), 'light');
    for (const v of ['heavy', 'Full', 'rewrite', 'transform']) assert.equal(appearanceScope(v), 'heavy');
    const base = { kind: 'appearance', intent: 'gnoll', fields: 'body', layer: {} };
    assert.notEqual(contentIdOf({ ...base, scope: 'heavy' }, 0, 60), contentIdOf({ ...base, scope: 'light' }, 0, 60));
    assert.equal(contentIdOf({ ...base, scope: 'light' }, 0, 60), contentIdOf(base, 0, 60), 'old light changes keep their key');
    const tool = scene.toolNpcStamp({ action: 'appearance', id: 'hesk', intent: 'gnoll', scope: 'heavy', why: 'transformed' });
    assert.equal(tool.scope, 'heavy');
    assert.equal(tool.why, 'transformed');
    assert.equal(scene.toolNpcStamp({ action: 'appearance', id: 'hesk', intent: 'dye' }).scope, 'light');
});

test('the person card is laid out like the place card: summary list, framed Removed/Added panel, same button order', async () => {
    const { c, prompts } = boot();
    const { renderDiff } = await import('../../plugin/ui/diffview.mjs');
    const next = appearance({ intent: 'turned into a gnoll', fields: 'body', layer: { body: 'a furred gnoll' }, lasts: 60, owner: 'g1' });
    c.chat = [msg([next])];
    c.generateRaw = async (args) => { prompts.push(String(args.prompt)); return '{"body":"a furred gnoll with a long snout","outfit":"wool"}'; };
    const filled = await scene.fillCandidate(c.chat, next.identity, { baseline: { body: 'a tall woman. Pale grey eyes.', outfit: 'wool' }, name: 'Hesk', elapsed: 0 });
    assert.equal(filled.ok, true, filled.error);
    const doc = makeDoc();
    globalThis.document = doc;
    renderPatchCards();
    const card = doc.querySelector('.worldscrawl_npcpending');
    assert.ok(card);
    assert.match(card.textContent, /Proposed person change:/);
    const items = card.querySelectorAll('li').map(li => li.textContent);
    assert.deepEqual(items, ['Hesk: body rewritten (for 1h)']);
    const place = card.querySelector('.wsdiff-place');
    assert.ok(place, 'framed panel like a place');
    assert.match(place.querySelector('.wsdiff-title').textContent, /^Hesk/);
    assert.equal(place.querySelector('.wsdiff-tag').textContent, 'person · changed');
    const marks = place.querySelectorAll('.wsdiff-blk').map(b => b.getAttribute('data-mark')).filter(Boolean);
    assert.ok(marks.includes('Removed') && marks.includes('Added'), marks.join(','));
    // The place view draws the same blocks for the same text.
    const area = renderDiff(doc, { before: { 'r/a': { name: 'Room', description: 'a tall woman. Pale grey eyes.' } }, after: { 'r/a': { name: 'Room', description: 'a furred gnoll with a long snout' } } });
    assert.deepEqual(area.querySelectorAll('.wsdiff-blk').map(b => b.getAttribute('data-mark')), place.querySelectorAll('.wsdiff-blk').map(b => b.getAttribute('data-mark')));
    const order = card.querySelectorAll('.worldscrawl_card_btn').map(b => b.textContent);
    assert.deepEqual(order, ['Check again', 'Edit', 'Make it a full rewrite', 'Approve', 'Discard']);

    // Edit opens the change in a box, like the place card's editor; rewriting with it re-asks and comes back for review.
    byText(doc, '.worldscrawl_card_btn', 'Edit').click();
    await flush();
    const box = doc.querySelector('.worldscrawl_npc_intent');
    assert.ok(box);
    assert.ok(!byText(doc, '.worldscrawl_card_btn', 'Approve'), 'plain Approve gives way to Approve edited while editing');
    // While editing the row follows the place card's: Check again, Close editor, scope switch, Rewrite with this, Approve edited, Discard.
    assert.deepEqual(doc.querySelector('.worldscrawl_npcpending').querySelectorAll('.worldscrawl_card_btn').map(b => b.textContent),
        ['Check again', 'Close editor', 'Make it a full rewrite', 'Rewrite with this', 'Approve edited', 'Discard']);
    box.value = 'turned into a wolf';
    box.dispatchEvent({ type: 'input' });
    byText(doc, '.worldscrawl_card_btn', 'Rewrite with this').click();
    await flush();
    assert.equal(next.candidate.intent, 'turned into a wolf');
    assert.equal(next.candidate.phase, 'review');
});

// ---- fix/npc-five: tracker scope, full rewrite prompt, direct text edit, learned names, finding by alias.
const { readTrackerAnswer, trackerPeopleLines } = await import('../../extension/tracker.mjs');
const { applyTrackerResult } = await import('../../extension/discovery.mjs');
const { FOUND_KEY } = await import('../../extension/npc.mjs');
const { findPerson, knows } = await import('../../extension/names.mjs');
const { bracketIntent, parseBracket } = await import('../../extension/brackets.mjs');
const LANDLADY = { ...HESK, unknownAs: 'the landlady' };
const promptText = id => PROMPTS.prompts.find(e => e.id === id).text;
const { exitsCache } = await import('../../extension/footer.mjs');
const roomFetch = () => { exitsCache.clear(); globalThis.fetch = async () => ({ ok: true, status: 200, headers: { get: () => '' }, json: async () => ({ address: 'riverton:drowned_rat/bar', name: 'Bar', display_name: 'Bar', description: '', exits: [] }) }); };

test('real tracker JSON keeps scope and why all the way to the owner, the rewrite prompt and the card', async () => {
    const { c, prompts } = boot();
    c.chat = [msg([])];
    c.generateRaw = async (args) => { const p = String(args?.prompt ?? ''); prompts.push(p); return /Looks line/.test(p) ? '{"looks":"a gnoll"}' : '{"body":"a hulking gnoll","outfit":"wool"}'; };
    const raw = '```json\n{"place": null, "people": [{"id": "hesk", "action": "appearance", "intent": "turned into a gnoll", "fields": "body", "lasts": "1 hour", "scope": "heavy", "why": "her whole body changed"}], "wait": null}\n```';
    const parsed = readTrackerAnswer(raw);
    assert.equal(parsed.people[0].scope, 'heavy');
    assert.equal(parsed.people[0].why, 'her whole body changed');
    await applyTrackerResult(0, parsed);
    const owner = owners(c.chat).at(-1);
    assert.equal(owner.candidate.scope, 'heavy');
    assert.equal(owner.candidate.why, 'her whole body changed');
    assert.equal(owner.candidate.phase, 'review', 'applyTrackerResult filled the candidate itself');
    assert.ok(prompts.some(p => /turned into a gnoll \[body\] \(full rewrite\)/.test(p)), 'the rewrite was asked as a full rewrite');
    const doc = makeDoc();
    globalThis.document = doc;
    renderPatchCards();
    const card = doc.querySelector('.worldscrawl_npcpending');
    assert.match(card.querySelector('.worldscrawl_scope').textContent, /^Full rewrite: her whole body changed$/);
    assert.ok(byText(doc, '.worldscrawl_card_btn', 'Make it a light touch'));
});

test('a tracker answer with no scope is a light touch that says it was not judged, not a reason nobody gave', async () => {
    const { c } = boot();
    c.chat = [msg([])];
    await applyTrackerResult(0, readTrackerAnswer('{"people": [{"id": "hesk", "action": "appearance", "intent": "hair dyed blue", "fields": "body", "why": "only her hair"}]}'));
    const owner = owners(c.chat).at(-1);
    assert.equal(owner.candidate.scope, 'light');
    assert.equal(owner.candidate.why, 'not judged, so the default');
    const doc = makeDoc();
    globalThis.document = doc;
    renderPatchCards();
    assert.equal(doc.querySelector('.worldscrawl_scope').textContent, 'Light touch: not judged, so the default');
});

test('prompts: the tracker judges scope by the result, and a full rewrite rebuilds the field instead of keeping sentences', () => {
    const tracker = promptText('npc.tracker');
    assert.match(tracker, /Always set scope/);
    assert.match(tracker, /not by how many words the change takes: "turned into a gnoll" is short but heavy/);
    const sys = promptText('npc.appearance_rebuild_system');
    assert.doesNotMatch(sys, /keep details the change does not contradict/);
    assert.match(sys, /For a full rewrite, write that field again from scratch for what they are now/);
    assert.match(sys, /frame and build, skin, fur or scales, head and face, hands/);
    assert.match(sys, /Do not keep the base's sentences or follow its sentence structure/);
    assert.match(sys, /Carry over only identifying details that still make sense on the new body, such as a scar or eye colour/);
    assert.match(sys, /For a light touch, change only the words that intent names and keep every other word as written\./);
    assert.match(sys, /Never copy a previous combined description; start from the base\./);
});

test('Edit shows the proposed Body and Outfit text; Approve edited commits exactly that text with no fields call, then re-summarizes Looks', async () => {
    const { c, prompts } = boot();
    const next = appearance({ intent: 'turned into a gnoll', fields: 'body', layer: {}, owner: 'ed1' });
    c.chat = [msg([next])];
    c.generateRaw = async (args) => { const p = String(args?.prompt ?? ''); prompts.push(p); return /Looks line/.test(p) ? '{"looks":"a grey-eyed gnoll"}' : '{"body":"a furred gnoll","outfit":"wool"}'; };
    const filled = await scene.fillCandidate(c.chat, next.identity, { baseline: { body: 'sturdy', outfit: 'wool' }, name: 'Hesk', elapsed: 0 });
    assert.equal(filled.ok, true, filled.error);
    const doc = makeDoc();
    globalThis.document = doc;
    renderPatchCards();
    byText(doc, '.worldscrawl_card_btn', 'Edit').click();
    await flush();
    const boxes = doc.querySelectorAll('.worldscrawl_npc_text');
    // Only the fields the panel shows as changed are editable: a body change edits Body, not Outfit.
    assert.deepEqual(boxes.map(b => [b.dataset.part, b.dataset.field, b.value]), [['lasting', 'body', 'a furred gnoll']]);
    assert.ok(doc.querySelector('.worldscrawl_npc_intent'), 'the Change box and Rewrite with this stay');
    assert.ok(byText(doc, '.worldscrawl_card_btn', 'Rewrite with this'));
    assert.deepEqual(doc.querySelector('.worldscrawl_npcpending').querySelectorAll('.worldscrawl_card_btn').map(b => b.textContent),
        ['Check again', 'Close editor', 'Make it a full rewrite', 'Rewrite with this', 'Approve edited', 'Discard']);
    boxes[0].value = 'A hulking grey gnoll with a scar through one eyebrow.';
    boxes[0].dispatchEvent({ type: 'input' });
    const fieldCalls = () => prompts.filter(p => !/Looks line/.test(p)).length;
    const before = fieldCalls();
    const rev = next.decisionRev;
    const approve = byText(doc, '.worldscrawl_card_btn', 'Approve edited');
    approve.click();
    approve.click();
    await flush();
    assert.equal(next.decisionRev, rev + 1, 'the second click is ignored');
    assert.equal(next.candidate, null);
    assert.equal(next.committed.layer.body, 'A hulking grey gnoll with a scar through one eyebrow.');
    assert.equal(next.committed.layer.outfit, undefined, 'an untouched field is not pinned');
    assert.equal(next.committed.fields, 'body');
    assert.equal(next.committed.edited, true);
    assert.equal(next.committed.why, 'text edited by you');
    assert.equal(next.lasts, null);
    assert.equal(fieldCalls(), before, 'approving typed text asks no rewrite');
    const live = npcAt(c.chat, 0, [HESK], 'hesk', () => ({ elapsed: 0 }));
    assert.equal(live.body, 'A hulking grey gnoll with a scar through one eyebrow.');
    assert.equal(live.outfit, 'wool');
    assert.ok(prompts.some(p => /Looks line/.test(p) && /A hulking grey gnoll/.test(p)), 'Looks is summarized from the typed body');
    assert.equal(live.looks, 'a grey-eyed gnoll');
    assert.equal(cacheRows(c.chat), false);
});

test('Approve edited on a temporary change edits the for-now text and keeps its duration', async () => {
    const { c, prompts } = boot();
    const next = appearance({ intent: 'soaked', fields: 'outfit', layer: {}, lasts: 60, owner: 'ed2' });
    c.chat = [msg([next])];
    c.generateRaw = async (args) => { const p = String(args?.prompt ?? ''); prompts.push(p); return /Looks line/.test(p) ? '{"looks":"dripping"}' : '{"body":"sturdy","outfit":"a soaked wool dress"}'; };
    const filled = await scene.fillCandidate(c.chat, next.identity, { baseline: { body: 'sturdy', outfit: 'wool' }, name: 'Hesk', elapsed: 0 });
    assert.equal(filled.ok, true, filled.error);
    const doc = makeDoc();
    globalThis.document = doc;
    renderPatchCards();
    byText(doc, '.worldscrawl_card_btn', 'Edit').click();
    await flush();
    const boxes = doc.querySelectorAll('.worldscrawl_npc_text');
    assert.deepEqual(boxes.map(b => [b.dataset.part, b.dataset.field]), [['live', 'outfit']]);
    const outfit = boxes.find(b => b.dataset.field === 'outfit');
    outfit.value = 'a wool dress wrung out and still dripping';
    outfit.dispatchEvent({ type: 'input' });
    byText(doc, '.worldscrawl_card_btn', 'Approve edited').click();
    await flush();
    assert.equal(next.committed?.layer?.outfit, 'a wool dress wrung out and still dripping');
    assert.equal(next.lasts, 60);
    assert.equal(npcAt(c.chat, 0, [HESK], 'hesk', () => ({ elapsed: 0 })).outfit, 'a wool dress wrung out and still dripping');
    assert.equal(npcAt(c.chat, 0, [HESK], 'hesk', () => ({ elapsed: 3600 })).outfit, 'wool', 'it still wears off');
});

test('Approve edited with text identical to now refuses instead of committing a no-op', async () => {
    const { c } = boot();
    const next = appearance({ intent: 'gnoll', fields: 'body', layer: {}, owner: 'ed3' });
    c.chat = [msg([next])];
    await scene.fillCandidate(c.chat, next.identity, { baseline: { body: 'sturdy', outfit: 'wool' }, name: 'Hesk', elapsed: 0 });
    const res = scene.decideNpc(c.chat, next.identity, next.decisionRev, 'approve', { token: next.candidate.token, elapsed: 0, edited: { lasting: { body: 'sturdy', outfit: 'wool' } } });
    assert.equal(res.ok, false);
    assert.match(res.error, /same as now/);
    assert.equal(next.committed, null);
});

test('the tracker is told who is not known by name; its name item for someone not in the scene stamps nothing', async () => {
    const { c } = boot();
    rememberWorlds({ default: 'riverton', worlds: [{ id: 'riverton', name: 'Riverton', cast: [LANDLADY] }] });
    const lines = trackerPeopleLines([{ id: 'hesk', name: 'Hesk', unknownAs: 'the landlady', nameKnown: false }, { id: 'tam', name: 'Tam', nameKnown: true }]);
    assert.match(lines, /^Hesk \[hesk\] \(name not yet known\)\. Looks: /);
    assert.doesNotMatch(lines, /they know this person only as/, 'the shown name is the line\'s own name: no second "known only as" line');
    assert.doesNotMatch(lines.split('\n')[1], /not yet known/);
    const tp = promptText('npc.tracker');
    assert.match(tp, /listed above as \(name not yet known\) has their name said in this exchange[^\n]*"action": "name"/);
    assert.match(tp, /with id set to the handle in \[brackets\] after their name/);
    assert.match(tp, /Call people by the names they have above and in the exchange \(never "the stranger", never a bracketed handle\)/);
    assert.doesNotMatch(tp, /real name/i);
    c.chat = [msg([])];
    assert.equal(knows(npcAt(c.chat, 0, [LANDLADY], 'hesk')).known, false);
    // She is not in the scene and nobody said her name in dialogue: the portal refuses the learn (names.test.mjs has the rest).
    await applyTrackerResult(0, readTrackerAnswer('{"people": [{"id": "hesk", "action": "name", "name": "Hesk"}]}'));
    assert.equal((c.chat[0].extra[NPC_KEY] ?? []).some(s => s.type === 'npc_name'), false);
    assert.equal(knows(npcAt(c.chat, 0, [LANDLADY], 'hesk')).known, false);
    // By the shown name with no name heard: still nothing.
    c.chat = [msg([])];
    await applyTrackerResult(0, readTrackerAnswer('{"people": [{"id": "the landlady", "action": "name"}]}'));
    assert.equal(knows(npcAt(c.chat, 0, [LANDLADY], 'hesk')).known, false);
});

test('[find] and [found] reach Hesk by "the landlady"; an ambiguous alias matches nobody', async () => {
    const { c } = boot();
    rememberWorlds({ default: 'riverton', worlds: [{ id: 'riverton', name: 'Riverton', cast: [LANDLADY] }] });
    roomFetch();
    for (const text of ['I [find] the landlady', 'I [found] landlady']) {
        const b = parseBracket(text);
        assert.equal(b.verb, 'found');
        const user = { mes: text, is_user: true, swipe_id: 0, extra: {} };
        c.chat = [msg([]), user];
        const r = await bracketIntent(user, b);
        assert.equal(r.kind, 'found', r.note);
        const d = user.extra[FOUND_KEY].at(-1);
        assert.equal(d.id, 'hesk', d.reason);
        assert.doesNotMatch(d.reason, /No saved person/);
    }
    // The tracker's found action goes through the same lookup.
    c.chat = [msg([])];
    await applyTrackerResult(0, readTrackerAnswer('{"people": [{"action": "found", "name": "the landlady"}]}'));
    assert.equal(c.chat[0].extra[FOUND_KEY].at(-1).id, 'hesk');
    const guards = [{ id: 'g1', name: 'Bors', unknownAs: 'the old guard' }, { id: 'g2', name: 'Ulf', unknownAs: 'the gate guard' }];
    assert.equal(findPerson('guard', guards), null, 'two people fit: no match');
    assert.equal(findPerson('the gate guard', guards).id, 'g2', 'an exact shown name still wins');
    assert.equal(findPerson('guard', [...guards, { id: 'g3', name: 'Guard', unknownAs: '' }, { id: 'g4', name: 'Ivo', unknownAs: 'the guard' }]), null, 'a name and another person\'s shown name tie: no match');
    assert.equal(findPerson("the landlady's daughter", [LANDLADY]), null, 'a longer description is not her');
    assert.equal(findPerson('the', [LANDLADY]), null);
    assert.equal(findPerson('Hesk', [LANDLADY]).id, 'hesk');
});

// ---- fix/expiry-notices: person expiries get a notice, reach the narrator, the tracker and a wait's summary;
// a no-op proposal drops itself; the revert is editable; "[wait] until HH:MM" lands on that minute.
const { waitFacts, keepWait, editKeptWait } = await import('../../extension/waits.mjs');
const { onStorySwipe } = await import('../../extension/discovery.mjs');
const { calendarLib, chatElapsed, clockAt } = await import('../../extension/clock.mjs');
const { NPC_EXPIRED_KIND } = await import('../../extension/npcexpiry.mjs');
const { callNotes } = await import('../../extension/calllog.mjs');
const ROOM = { address: 'riverton:drowned_rat/bar', name: 'Bar', display_name: 'Bar', description: '', exits: [] };
function bootAt(time = '16:20', cast = [LANDLADY]) {
    const env = boot();
    rememberWorlds({ default: 'riverton', worlds: [{ id: 'riverton', name: 'Riverton', cast, start_date: { year: 1, day: 1, time } }] });
    roomFetch();
    const facts = [];
    env.c.setExtensionPrompt = (key, text) => { if (key === 'worldscrawl_facts' || /facts/i.test(String(key))) facts.push(String(text ?? '')); };
    env.facts = facts;
    return env;
}
const clockText = chat => { const d = calendarLib.dateAt(chatElapsed(chat), { year: 1, day: 1, time: '16:20' }, null); return `${String(d.hour).padStart(2, '0')}:${String(d.minute).padStart(2, '0')}`; };
const userMsg = mes => ({ mes, is_user: true, swipe_id: 0, extra: {} });
/** The model: tracker answers from `tracker`, rewrites return `fields`, Looks lines return `looks`. */
function model(c, prompts, { tracker = '{"place": null, "people": [], "wait": null}', fields = '{"body":"a furred gnoll","outfit":"wool"}', looks = '{"looks":"a hulking gnoll"}' } = {}) {
    c.generateRaw = async (args) => {
        const p = String(args?.prompt ?? '');
        prompts.push(p);
        if (/Looks line/.test(p)) return typeof looks === 'function' ? looks(p) : looks;
        if (/Reply with JSON only:\n\{"place"/.test(p)) return typeof tracker === 'function' ? tracker(p) : tracker;
        return typeof fields === 'function' ? fields(p) : fields;
    };
}
/** Hesk turned into a gnoll for an hour at 16:20, through the real tracker JSON, fill and chat-card approval path. */
async function gnollFor1h(c, prompts) {
    model(c, prompts);
    c.chat = [msg([])];
    await applyTrackerResult(0, readTrackerAnswer('{"place": null, "people": [{"id": "hesk", "action": "appearance", "intent": "turned into a gnoll", "fields": "body", "lasts": "1 hour", "scope": "heavy", "why": "her whole body changed"}], "wait": null}'));
    const owner = owners(c.chat).at(-1);
    assert.equal(owner.candidate.phase, 'review');
    const res = await scene.settleNpc(c.chat, owner.identity, owner.decisionRev, 'approve', { token: owner.candidate.token, elapsed: 0 });
    assert.equal(res.ok, true, res.error);
    assert.equal(npcAt(c.chat, 0, [LANDLADY], 'hesk', i => ({ elapsed: chatElapsed(c.chat.slice(0, i + 1)) })).body, 'a furred gnoll');
    return owner;
}

test('[wait] until 17:15 lands on 17:15 exactly (the bracket no longer stops at the colon), with no model call', async () => {
    const { c, prompts } = bootAt('16:20');
    model(c, prompts);
    for (const [text, at] of [['I [wait] until 17:15.', '17:15'], ['[wait] until 5:15 pm, then I leave', '17:15'], ['[wait] until 17.15', '17:15'], ['[wait] 1.5h', '17:50']]) {
        const b = parseBracket(text);
        const user = userMsg(text);
        c.chat = [msg([]), user];
        const r = await bracketIntent(user, b);
        assert.notEqual(r.kind, 'bracket_failed', r.note);
        assert.equal(clockText(c.chat), at, text);
    }
    assert.equal(prompts.length, 0, 'the parser read every amount; no wait-amount model call');
    // Already past today: the next 17:15.
    const user = userMsg('[wait] until 17:15');
    c.chat = [msg([]), userMsg('[wait] 1h30m'), user];
    await bracketIntent(c.chat[1], parseBracket(c.chat[1].mes));
    assert.equal(clockText(c.chat.slice(0, 2)), '17:50');
    await bracketIntent(user, parseBracket(user.mes));
    assert.equal(clockText(c.chat), '17:15');
    assert.equal(c.chat[2].extra.worldscrawl_wait.seconds, 23 * 3600 + 25 * 60, 'tomorrow, not today');
});

test('a tracker wait {until: "17:15"} kept on its card also lands on 17:15', async () => {
    const { c, prompts } = bootAt('16:20');
    model(c, prompts);
    c.chat = [msg([])];
    await applyTrackerResult(0, readTrackerAnswer('{"place": null, "people": [], "wait": {"duration": "", "until": "17:15", "sleep": false, "reason": "waiting for the coach"}}'));
    assert.ok(c.chat[0].extra.worldscrawl_waitcard, 'a card waits for the player');
    assert.equal(await keepWait(0), '');
    assert.equal(clockText(c.chat), '17:15');
});

test('a person expiry crossed by a wait: the wait summary names her, one engine notice, the narrator note, the tracker is told, and a no-op proposal drops itself', async () => {
    const { c, prompts, facts } = bootAt('16:20');
    await gnollFor1h(c, prompts);
    const user = userMsg('I [wait] 2h');
    c.chat.push(user);
    await bracketIntent(user, parseBracket(user.mes));
    const live = npcAt(c.chat, 1, [LANDLADY], 'hesk', i => ({ elapsed: chatElapsed(c.chat.slice(0, i + 1)) }));
    assert.equal(live.body, 'sturdy', 'the engine reverted her');
    // E: the wait's "ran out" line, from the real waitFacts.
    const wf = await waitFacts(c.chat, ROOM);
    assert.match(wf, /these temporary changes ran out and are gone now: the temporary change "turned into a gnoll" on the landlady\./, 'the narrator gets what the player knows her as');
    assert.match(wf, /Describe the people as they are now/);
    // A: one notice, like a place expiry's [Engine: ...] line, never twice.
    const posted = await scene.postPersonExpiryNotices();
    assert.ok(posted);
    const notice = c.chat.at(-1);
    assert.equal(notice.is_system, true);
    assert.equal(notice.extra.worldscrawl_notice, true);
    assert.equal(notice.extra.worldscrawl_notice_kind, NPC_EXPIRED_KIND);
    assert.equal(notice.mes, '[Engine: Hesk (known to you only as "the landlady"): "turned into a gnoll" ran out. Looks now: copper braids]');
    assert.equal(await scene.postPersonExpiryNotices(), null, 'already announced');
    assert.equal(c.chat.filter(m => m.extra?.worldscrawl_notice_kind === NPC_EXPIRED_KIND).length, 1);
    // B: the narrator's facts say who changed back and how she looks now.
    await scene.applyFacts();
    const text = facts.at(-1);
    assert.match(text, /Engine note \(already applied; this is the same person, not someone new\)/);
    // The facts block goes through the name portal: she is not named there.
    assert.match(text, /- The landlady: the temporary change "turned into a gnoll" ran out and is gone/);
    assert.doesNotMatch(text, /Hesk/);
    assert.match(text, /What they look like now: Looks: copper braids Body: sturdy Outfit: wool/);
    // C: the story narrates her turning back; the tracker hears it already happened, and its proposal is dropped.
    const reply = { mes: 'Hesk shudders and shrinks back into her human shape, fur falling away.', is_user: false, swipe_id: 0, swipe_info: [{ extra: {} }], extra: {} };
    c.chat.push(reply);
    const at = c.chat.length - 1;
    model(c, prompts, {
        tracker: '{"place": null, "people": [{"id": "hesk", "action": "appearance", "intent": "turned back into a woman", "fields": "body", "scope": "heavy", "why": "the gnoll shape is gone"}], "wait": null}',
        fields: '{"body":"sturdy","outfit":"wool"}',
    });
    await onStorySwipe(at);
    const trackerPrompt = prompts.find(p => /Reply with JSON only:\n\{"place"/.test(p));
    assert.match(trackerPrompt, /Already done by the game \(not new changes; do not report them\):\nThe landlady \[p[0-9a-z]+\]: The temporary change "turned into a gnoll" on the landlady ran out; the game already changed them back\. The Body and Outfit listed above are the result\./);
    assert.doesNotMatch(trackerPrompt.split('\n\nPlayer:')[0], /Hesk|\[hesk\]/, 'the engine part; the story is the story');
    assert.ok(prompts.some(p => /turned back into a woman \[body\]/.test(p)), 'the proposal really went through the fill');
    assert.match(trackerPrompt, /Do not report an appearance change, or a fact, that only describes something under "Already done by the game"/);
    assert.equal((reply.extra[NPC_KEY] ?? []).some(s => s.type === 'npc_appearance'), false, 'the no-op proposal is not left Waiting on you');
    assert.ok(callNotes(reply).some(n => n.kind === 'npc_appearance' && n.status === 'skipped' && /no change: the result matches how Hesk looks now/.test(n.reason)), JSON.stringify(callNotes(reply)));
    const doc = makeDoc();
    globalThis.document = doc;
    doc.querySelector('.mes').setAttribute('mesid', String(at));
    renderPatchCards();
    assert.equal(doc.querySelector('.worldscrawl_npcpending'), null);
    // The next turn is not told again.
    c.chat.push(userMsg('I look at her.'));
    assert.deepEqual(scene.freshPersonExpiries(c.chat, c.chat.length - 1), []);
    await scene.applyFacts();
    assert.doesNotMatch(facts.at(-1), /Engine note/);
});

test('the no-op backstop keeps a real change: a tracker proposal that does change her still waits on the card', async () => {
    const { c, prompts } = bootAt('16:20');
    model(c, prompts, { fields: '{"body":"sturdy, with a fresh bruise on one cheek","outfit":"wool"}' });
    c.chat = [msg([])];
    await applyTrackerResult(0, readTrackerAnswer('{"people": [{"id": "hesk", "action": "appearance", "intent": "a bruise on her cheek", "fields": "body", "lasts": "1 day", "scope": "light", "why": "one detail"}]}'));
    const owner = owners(c.chat).at(-1);
    assert.equal(owner.candidate.phase, 'review');
    const doc = makeDoc();
    globalThis.document = doc;
    renderPatchCards();
    assert.ok(doc.querySelector('.worldscrawl_npcpending'));
});

test('the expiry notice Edit: Body/Outfit boxes like the person card, Approve edited commits a player-edited lasting change once', async () => {
    const { c, prompts } = bootAt('16:20');
    await gnollFor1h(c, prompts);
    const user = userMsg('[wait] 2h');
    c.chat.push(user);
    await bracketIntent(user, parseBracket(user.mes));
    await scene.postPersonExpiryNotices();
    const at = c.chat.length - 1;
    const doc = makeDoc();
    globalThis.document = doc;
    doc.querySelector('.mes').setAttribute('mesid', String(at));
    renderPatchCards();
    const box = doc.querySelector('.worldscrawl_npcexpired');
    assert.ok(box);
    assert.match(box.querySelector('.worldscrawl_card_summary').textContent, /Hesk: "turned into a gnoll" ran out/);
    const panel = box.querySelector('.worldscrawl_diff').textContent;
    assert.match(panel, /a furred gnoll/, 'before: while it lasted');
    assert.match(panel, /sturdy/, 'now');
    assert.deepEqual(buttons(box), ['Edit']);
    byText(box, '.worldscrawl_card_btn', 'Edit').click();
    await flush();
    const open = doc.querySelector('.worldscrawl_npcexpired');
    const tas = open.querySelectorAll('.worldscrawl_npc_text');
    assert.deepEqual(tas.map(t => [t.dataset.field, t.value]), [['body', 'sturdy'], ['outfit', 'wool']]);
    assert.deepEqual(buttons(open), ['Close editor', 'Approve edited']);
    tas[0].value = 'sturdy, with a few coarse gnoll hairs still clinging to her forearms';
    tas[0].dispatchEvent({ type: 'input' });
    const fieldCalls = () => prompts.filter(p => !/Looks line/.test(p) && !/Reply with JSON only/.test(p)).length;
    const before = fieldCalls();
    const ok = byText(open, '.worldscrawl_card_btn', 'Approve edited');
    ok.click();
    ok.click();
    await flush();
    const mine = (c.chat[at].extra[NPC_KEY] ?? []).filter(s => s.type === 'npc_appearance');
    assert.equal(mine.length, 1, 'the second click is ignored');
    const o = mine[0];
    assert.equal(o.candidate, null);
    assert.equal(o.committed.layer.body, 'sturdy, with a few coarse gnoll hairs still clinging to her forearms');
    assert.equal(o.committed.fields, 'body');
    assert.equal(o.committed.edited, true);
    assert.equal(o.by, 'player');
    assert.equal(o.lasts, null);
    assert.equal(o.source, 'expiry_edit');
    assert.equal(fieldCalls(), before, 'typed text needs no rewrite call');
    const now = npcAt(c.chat, c.chat.length - 1, [LANDLADY], 'hesk', i => ({ elapsed: chatElapsed(c.chat.slice(0, i + 1)) }));
    assert.equal(now.body, 'sturdy, with a few coarse gnoll hairs still clinging to her forearms');
    assert.equal(now.outfit, 'wool');
    renderPatchCards();
    assert.equal(doc.querySelector('.worldscrawl_npcexpired').querySelectorAll('.worldscrawl_card_btn').length, 0, 'the notice Edit gives way to the change row');
    const rowOf = () => [...doc.querySelectorAll('.worldscrawl_npcchange')].find(r => /as you wrote it/.test(r.textContent));
    let row = rowOf();
    assert.deepEqual(buttons(row), ['Edit', 'Turn off', 'Undo']);
    // The kept change's Edit opens the same Body/Outfit editor (same classes) as the notice's.
    byText(row, '.worldscrawl_card_btn', 'Edit').click();
    await flush();
    row = rowOf();
    const again = row.querySelectorAll('.worldscrawl_npc_text');
    assert.deepEqual(again.map(t => [t.dataset.field, t.value]), [['body', 'sturdy, with a few coarse gnoll hairs still clinging to her forearms']]);
    assert.ok(row.querySelector('.worldscrawl_card_editor'), 'the shared editor');
    assert.deepEqual(buttons(row), ['Close editor', 'Approve edited', 'Turn off', 'Undo']);
    byText(row, '.worldscrawl_card_btn', 'Close editor').click();
    await flush();
    const nowBody = () => npcAt(c.chat, c.chat.length - 1, [LANDLADY], 'hesk', i => ({ elapsed: chatElapsed(c.chat.slice(0, i + 1)) })).body;
    byText(rowOf(), '.worldscrawl_card_btn', 'Turn off').click();
    await flush();
    assert.equal(o.off, true);
    assert.equal(nowBody(), 'sturdy');
    assert.deepEqual(buttons(rowOf()), ['Turn on', 'Undo']);
    byText(rowOf(), '.worldscrawl_card_btn', 'Turn on').click();
    await flush();
    assert.equal(o.off, false);
    assert.equal(nowBody(), 'sturdy, with a few coarse gnoll hairs still clinging to her forearms');
    byText(rowOf(), '.worldscrawl_card_btn', 'Undo').click();
    await flush();
    assert.equal(nowBody(), 'sturdy');
    // Same text as now refuses instead of saving a no-op.
    const res = await scene.editExpiryRevert(at, 'hesk', { body: 'sturdy', outfit: 'wool' });
    assert.equal(res.ok, false);
    assert.match(res.error, /same as now/);
});

test('person expiry stale: a notice deleted or swiped after the card was drawn saves nothing', async () => {
    const { c, prompts } = bootAt('16:20');
    await gnollFor1h(c, prompts);
    const user = userMsg('[wait] 2h');
    c.chat.push(user);
    await bracketIntent(user, parseBracket(user.mes));
    await scene.postPersonExpiryNotices();
    const at = c.chat.length - 1, notice = c.chat[at];
    const doc = makeDoc();
    globalThis.document = doc;
    doc.querySelector('.mes').setAttribute('mesid', String(at));
    renderPatchCards();
    byText(doc.querySelector('.worldscrawl_npcexpired'), '.worldscrawl_card_btn', 'Edit').click();
    await flush();
    const typeIn = () => { const ta = doc.querySelector('.worldscrawl_npcexpired').querySelectorAll('.worldscrawl_npc_text')[0]; ta.value = 'sturdy, freckled'; ta.dispatchEvent({ type: 'input' }); };
    typeIn();
    const expiryEdits = () => c.chat.flatMap(m => m?.extra?.[NPC_KEY] ?? []).filter(s => s.source === 'expiry_edit');
    // Swiped: the card was drawn on swipe 0.
    let ok = byText(doc.querySelector('.worldscrawl_npcexpired'), '.worldscrawl_card_btn', 'Approve edited');
    notice.swipe_id = 1;
    ok.click();
    await flush();
    assert.equal(expiryEdits().length, 0, 'a swiped notice saves nothing');
    notice.swipe_id = 0;
    renderPatchCards();
    typeIn();
    // Deleted.
    ok = byText(doc.querySelector('.worldscrawl_npcexpired'), '.worldscrawl_card_btn', 'Approve edited');
    c.chat.splice(at, 1);
    ok.click();
    await flush();
    assert.equal(expiryEdits().length, 0, 'a deleted notice saves nothing');
    assert.equal((notice.extra[NPC_KEY] ?? []).length, 0);
});

test('a kept temporary change: Edit → Approve edited saves the typed for-now text and keeps its duration; a stale kept card does nothing', async () => {
    const { c, prompts } = bootAt('16:20');
    const o = await gnollFor1h(c, prompts);
    const doc = makeDoc();
    globalThis.document = doc;
    renderPatchCards();
    const rowOf = () => doc.querySelector('.worldscrawl_npcchange');
    byText(rowOf(), '.worldscrawl_card_btn', 'Edit').click();
    await flush();
    const tas = rowOf().querySelectorAll('.worldscrawl_npc_text');
    assert.deepEqual(tas.map(t => [t.dataset.part, t.dataset.field, t.value]), [['live', 'body', 'a furred gnoll']]);
    tas[0].value = 'a grey-furred gnoll';
    tas[0].dispatchEvent({ type: 'input' });
    const before = prompts.length;
    byText(rowOf(), '.worldscrawl_card_btn', 'Approve edited').click();
    await flush();
    assert.equal(o.candidate, null);
    assert.equal(o.committed.layer.body, 'a grey-furred gnoll');
    assert.equal(o.lasts, 60, 'still lasts an hour');
    assert.equal(prompts.filter(p => /Rewrite body/.test(p)).length, prompts.slice(0, before).filter(p => /Rewrite body/.test(p)).length, 'no rewrite call');
    assert.equal(npcAt(c.chat, 0, [LANDLADY], 'hesk', i => ({ elapsed: chatElapsed(c.chat.slice(0, i + 1)) })).body, 'a grey-furred gnoll');
    // Stale: the card was drawn, then the change was turned off elsewhere (the map); its Undo does nothing.
    renderPatchCards();
    const undo = byText(rowOf(), '.worldscrawl_card_btn', 'Undo');
    const off = await scene.settleNpc(c.chat, o.identity, o.decisionRev, 'off', {});
    assert.equal(off.ok, true);
    undo.click();
    await flush();
    assert.ok((c.chat[0].extra[NPC_KEY] ?? []).includes(o), 'the stale Undo removed nothing');
    assert.equal(o.off, true);
});

test('re-timing a kept wait rechecks person expiries too, and a temporary fact that runs out is named in the wait line', async () => {
    const { c, prompts } = bootAt('16:20');
    await gnollFor1h(c, prompts);
    await applyTrackerResult(0, readTrackerAnswer('{"people": [{"id": "hesk", "action": "fact", "text": "has a split lip", "lasts": "90 minutes"}]}'));
    model(c, prompts);
    await applyTrackerResult(0, readTrackerAnswer('{"place": null, "people": [], "wait": {"duration": "30m", "until": "", "sleep": false, "reason": "a short rest"}}'));
    assert.equal(await keepWait(0), '');
    assert.equal(c.chat.some(m => m.extra?.worldscrawl_notice_kind === NPC_EXPIRED_KIND), false, 'nothing ran out in 30 minutes');
    const longer = await editKeptWait(0, '2h');
    assert.ok(longer.crossed.some(g => /"turned into a gnoll" on Hesk/.test(g.note)), JSON.stringify(longer.crossed));
    assert.ok(longer.crossed.some(g => /temporary detail "has a split lip" on Hesk/.test(g.note)));
    assert.ok(c.chat.some(m => m.extra?.worldscrawl_notice_kind === NPC_EXPIRED_KIND), 'the re-timed wait posts the notice');
    c.chat.splice(1);
    const shorter = await editKeptWait(0, '30m');
    assert.ok(shorter.uncrossed.some(g => /"turned into a gnoll" on Hesk/.test(g.note)));
    // The real waitFacts for a 2h wait lists both, people after the time passing.
    c.chat.push(userMsg('[wait] 2h'));
    await bracketIntent(c.chat[1], parseBracket(c.chat[1].mes));
    const wf = await waitFacts(c.chat, ROOM);
    assert.match(wf, /ran out and are gone now: [^\n]*the temporary change "turned into a gnoll" on the landlady[^\n]*; the temporary detail "has a split lip" on the landlady/);
});

// ---- S6: the cast Changes tab shows the chat's cards; a click runs the chat card's handler over the map channel
const { stampCard } = await import('../../plugin/ui/castdata.mjs');
function guiPanel(c) {
    Chan.all = [];
    globalThis.BroadcastChannel = Chan;
    openMapChannel();
    const gui = new Chan('worldscrawl');
    const doc = makeDoc();
    globalThis.document = doc;
    globalThis.getComputedStyle = () => ({ getPropertyValue: () => '', backgroundColor: '' });
    const env = { exists: () => true, relocate: {}, names: a => a, playerAt: () => '', clock: () => ({ elapsed: 0, day: 1, hour: 8, minute: 0, minutes: 480 }) };
    const panel = castPanel(doc, { load: async () => ({ npcs: [HESK] }), outline: async () => null, play: () => npcPlayState(c.chat, [HESK], env),
        decideNpc: spec => askGui(gui, 'npc_decide', { chatId: 'c1', ...spec }), chatAt: () => ({ msg: 0, swipe: 0 }), placeName: a => a });
    return { panel, gui, doc };
}
const guiCard = (panel, re) => panel.el.querySelectorAll('.cast-card').find(d => re.test(d.textContent));

test('GUI Changes: a memory card, collapsed; Edit → Approve edited → Turn off → Turn on → Undo run the chat card handler', async () => {
    const { c } = boot();
    c.chat = [msg([])];
    scene.addNpcStamp(c.chat[0], { type: 'npc_memory', id: 'hesk', note: 'she promised a room' });
    const s = c.chat[0].extra[NPC_KEY][0];
    const { panel } = guiPanel(c);
    await panel.refresh();
    panel.selectId('hesk', 'changes');
    let card = guiCard(panel, /promised a room/);
    assert.ok(!card.open, 'collapsed: the title line only until opened');
    assert.match(card.querySelector('summary').textContent, /#0.*promised a room/);
    assert.deepEqual(buttons(card), ['Edit', 'Turn off', 'Undo']);
    byText(card, '.worldscrawl_card_btn', 'Edit').click();
    await flush();
    card = guiCard(panel, /promised a room/);
    assert.equal(card.open, true, 'Edit keeps it open');
    assert.deepEqual(buttons(card), ['Close editor', 'Approve edited', 'Turn off', 'Undo']);
    const box = card.querySelector('.worldscrawl_note_text');
    assert.equal(box.value, 'she promised a room');
    box.value = 'she promised the attic room'; box.dispatchEvent({ type: 'input' });
    byText(card, '.worldscrawl_card_btn', 'Approve edited').click();
    await flush(); await flush();
    assert.equal(s.note, 'she promised the attic room', 'saved by the chat handler');
    panel.setPlay();
    card = guiCard(panel, /attic room/);
    assert.deepEqual(buttons(card), ['Edit', 'Turn off', 'Undo'], 'the editor closed');
    byText(card, '.worldscrawl_card_btn', 'Turn off').click();
    await flush(); await flush();
    assert.equal(s.off, true);
    panel.setPlay();
    card = guiCard(panel, /attic room/);
    assert.deepEqual(buttons(card), ['Turn on', 'Undo']);
    byText(card, '.worldscrawl_card_btn', 'Turn on').click();
    await flush(); await flush();
    assert.equal(s.off, false);
    panel.setPlay();
    byText(guiCard(panel, /attic room/), '.worldscrawl_card_btn', 'Undo').click();
    await flush(); await flush();
    assert.equal((c.chat[0].extra[NPC_KEY] ?? []).includes(s), false);
});

test('GUI Changes stale: a card drawn before the note changed in the chat writes nothing', async () => {
    const { c } = boot();
    c.chat = [msg([])];
    scene.addNpcStamp(c.chat[0], { type: 'npc_memory', id: 'hesk', note: 'she promised a room' });
    const s = c.chat[0].extra[NPC_KEY][0];
    const { panel } = guiPanel(c);
    await panel.refresh();
    panel.selectId('hesk', 'changes');
    byText(guiCard(panel, /promised/), '.worldscrawl_card_btn', 'Edit').click();
    await flush();
    const card = guiCard(panel, /promised/);
    const box = card.querySelector('.worldscrawl_note_text');
    box.value = 'typed in the map'; box.dispatchEvent({ type: 'input' });
    const ok = byText(card, '.worldscrawl_card_btn', 'Approve edited');
    s.note = 'she promised the cellar'; // changed in the chat (no revision bump): only the card's seen tag can tell
    ok.click();
    await flush(); await flush();
    assert.equal(s.note, 'she promised the cellar', 'the stale click wrote nothing');
    assert.match(panel.el.querySelector('.cast-msg').textContent, /moved on/);
});

test('GUI Changes: a person review Edit → Approve edited commits the typed Body (the chat card handler, no fields call)', async () => {
    const { c, prompts } = boot();
    const o = appearance({ intent: 'turned into a gnoll', fields: 'body', layer: {}, owner: 'gui1' });
    c.chat = [msg([o])];
    c.generateRaw = async (args) => { const p = String(args?.prompt ?? ''); prompts.push(p); return /Looks line/.test(p) ? '{"looks":"a grey-eyed gnoll"}' : '{"body":"a furred gnoll","outfit":"wool"}'; };
    const filled = await scene.fillCandidate(c.chat, o.identity, { baseline: { body: 'sturdy', outfit: 'wool' }, name: 'Hesk', elapsed: 0 });
    assert.equal(filled.ok, true, filled.error);
    const { panel } = guiPanel(c);
    await panel.refresh();
    panel.selectId('hesk', 'changes');
    let card = panel.el.querySelector('.cast-card');
    assert.deepEqual(buttons(card), ['Check again', 'Edit', 'Make it a full rewrite', 'Approve', 'Discard'], 'the chat review card\'s buttons');
    assert.ok(card.querySelector('.worldscrawl_diff'), 'review cards carry their panel');
    byText(card, '.worldscrawl_card_btn', 'Edit').click();
    await flush();
    card = panel.el.querySelector('.cast-card');
    assert.deepEqual(buttons(card), ['Check again', 'Close editor', 'Make it a full rewrite', 'Rewrite with this', 'Approve edited', 'Discard']);
    const boxes = card.querySelectorAll('.worldscrawl_npc_text');
    assert.deepEqual(boxes.map(b => b.value), ['a furred gnoll']);
    boxes[0].value = 'A hulking grey gnoll.'; boxes[0].dispatchEvent({ type: 'input' });
    const fields = () => prompts.filter(p => !/Looks line/.test(p)).length, before = fields();
    byText(card, '.worldscrawl_card_btn', 'Approve edited').click();
    await flush(); await flush();
    assert.equal(o.committed?.layer?.body, 'A hulking grey gnoll.');
    assert.equal(fields(), before, 'no fields call');
});

test('GUI payload: kept rows carry the summary only (no panel rows), with a short seen tag', () => {
    const { c } = boot();
    const o = commit(appearance({ intent: 'taller', fields: 'body', layer: { body: 'a towering woman' }, owner: 'opay' }));
    c.chat = [msg([o])];
    scene.addNpcStamp(c.chat[0], { type: 'npc_fact', id: 'hesk', field: 'fact', text: 'owes a favor' });
    const env = { exists: () => true, relocate: {}, names: a => a, playerAt: () => '', clock: () => ({ elapsed: 0, day: 1, hour: 8, minute: 0, minutes: 480 }) };
    const rows = npcPlayState(c.chat, [HESK], env).find(n => n.id === 'hesk').stamps;
    assert.equal(rows.length, 2);
    for (const x of rows) {
        assert.equal(x.diffs, undefined, `${x.type}: no panel rows`);
        assert.ok(typeof x.sig === 'string' && x.sig.length <= 8, x.sig);
        assert.ok(Number.isInteger(x.index));
        const card = stampCard(x, { who: 'Hesk' });
        assert.equal(card.desc.panel, null, `${x.type}: kept card has no panel until opened`);
    }
});

// ---- fix/e2e-gate: the tracker reads only an exchange, and never a story that has left the screen.
const { onReplyForFlags } = await import('../../extension/discovery.mjs');
const trackerReads = prompts => prompts.filter(p => /Reply with JSON only:\n\{"place"/.test(p));
const reply = mes => ({ mes, is_user: false, swipe_id: 0, swipes: [mes], swipe_info: [{ extra: {} }], extra: {} });

test('the tracker skips a greeting (no player line before it), [ws-start] marker included, and reads the first exchange', async () => {
    const { c, prompts } = bootAt('16:20');
    model(c, prompts);
    c.chat = [reply('Welcome, traveler. [ws-start]')];
    await onReplyForFlags(0);
    assert.equal(trackerReads(prompts).length, 0, 'no model call for the greeting');
    c.chat.push(userMsg('I look around.'), reply('A smoky bar.'));
    await onReplyForFlags(2);
    assert.equal(trackerReads(prompts).length, 1);
    assert.match(trackerReads(prompts)[0], /A smoky bar\./);
    assert.doesNotMatch(trackerReads(prompts)[0], /ws-start/);
});

test('a swipe still being written is read when its reply arrives, never on the old text; a read whose story changed in flight stamps nothing', async () => {
    const { c, prompts } = bootAt('16:20');
    ext.settings().autoKeepWaits = false;
    const WAIT = '{"place": null, "people": [], "wait": {"duration": "45m", "reason": "a long meal"}}';
    model(c, prompts, { tracker: WAIT });
    const r = reply('Old telling.');
    c.chat = [msg([]), userMsg('I eat.'), r];
    // SillyTavern while it writes a new swipe: swipe_id one past the end, mes still the old text.
    r.swipe_id = 1;
    await onStorySwipe(2);
    assert.equal(trackerReads(prompts).length, 0, 'nothing read while the swipe is being written');
    assert.equal(r.extra.worldscrawl_waitcard, undefined);
    // The new swipe arrives.
    r.swipes.push('New telling.'); r.mes = 'New telling.'; r.swipe_info.push({ extra: {} });
    await onReplyForFlags(2);
    assert.equal(trackerReads(prompts).length, 1);
    assert.match(trackerReads(prompts)[0], /New telling\./);
    assert.doesNotMatch(trackerReads(prompts)[0], /Old telling/);
    assert.ok(r.extra.worldscrawl_waitcard, 'the answer for the story on screen lands');
    // In flight: the story on screen changes (edited, or a new swipe started) before the answer comes back.
    for (const change of [m => { m.mes = 'Edited telling.'; }, m => { m.swipe_id = m.swipes.length; }]) {
        r.mes = 'New telling.'; r.swipe_id = 1;
        let release;
        const gate = new Promise(res => { release = res; });
        model(c, prompts, { tracker: () => gate.then(() => WAIT) });
        const reading = onStorySwipe(2); // drops the tracker's stamps, then reads swipe 1 again
        await new Promise(res => setTimeout(res, 20));
        assert.equal(r.extra.worldscrawl_waitcard, undefined);
        change(r);
        release();
        await reading;
        assert.equal(r.extra.worldscrawl_waitcard, undefined, 'the stale answer has nowhere to land');
    }
});
