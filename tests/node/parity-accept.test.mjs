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
const { loadCalendar, rememberWorlds } = await import('../../extension/clock.mjs');
const { syncSwipeExtra } = await import('../../extension/discovery.mjs');

const HESK = { ok: true, id: 'hesk', name: 'Hesk', line: 'landlady', looks: 'copper braids', body: 'sturdy', outfit: 'wool', file: 'hesk.json' };
const PROMPTS = JSON.parse(fs.readFileSync(new URL('../../plugin/prompts/default.json', import.meta.url), 'utf8'));

function matchOne(el, part) {
    let rest = part;
    if (rest[0] !== '.' && rest[0] !== '#' && rest[0] !== '[') {
        const tag = rest.split(/[#.\[]/)[0];
        if (tag && el.tag !== tag) return false;
        rest = rest.slice(tag.length);
    }
    while (rest) {
        if (rest[0] === '.') {
            const m = /^\.([^.#[\]]+)/.exec(rest);
            if (!m || !el.className.split(/\s+/).includes(m[1])) return false;
            rest = rest.slice(m[0].length);
        } else if (rest[0] === '#') {
            const m = /^#([^.#\[]+)/.exec(rest);
            if (!m || el.id !== m[1]) return false;
            rest = rest.slice(m[0].length);
        } else if (rest[0] === '[') {
            const m = /^\[([^\]=]+)(?:="([^"]*)")?\]/.exec(rest);
            if (!m) return false;
            const v = el.getAttribute(m[1]);
            if (v == null || (m[2] != null && v !== m[2])) return false;
            rest = rest.slice(m[0].length);
        } else return false;
    }
    return true;
}
function matchesDesc(el, parts) {
    if (!matchOne(el, parts[parts.length - 1])) return false;
    let i = parts.length - 2, p = el.parent;
    while (i >= 0 && p) { if (matchOne(p, parts[i])) i--; p = p.parent; }
    return i < 0;
}
class El {
    constructor(doc, tag) {
        this.ownerDocument = doc; this.tag = tag; this.children = []; this.parent = null;
        this.className = ''; this.id = ''; this._text = ''; this.attrs = {}; this.listeners = {};
        this.style = {}; this.dataset = {}; this.hidden = false; this.disabled = false; this.title = ''; this.value = '';
    }
    get parentNode() { return this.parent; }
    get childNodes() { return this.children; }
    appendChild(x) { this.append(x); return x; }
    insertBefore(x, before) { if (!x) return x; x.parent = this; const i = this.children.indexOf(before); if (i < 0) this.children.push(x); else this.children.splice(i, 0, x); return x; }
    get classList() {
        const el = this;
        const names = () => el.className.split(/\s+/).filter(Boolean);
        return {
            add: (...xs) => { el.className = [...new Set([...names(), ...xs])].join(' '); },
            remove: (...xs) => { const drop = new Set(xs); el.className = names().filter(n => !drop.has(n)).join(' '); },
            toggle: (x, force) => { const on = force === undefined ? !names().includes(x) : !!force; if (on) el.className = [...new Set([...names(), x])].join(' '); else el.className = names().filter(n => n !== x).join(' '); return on; },
            contains: x => names().includes(x),
        };
    }
    set textContent(v) { this._text = String(v ?? ''); this.children = []; }
    get textContent() { return this._text + this.children.map(c => c.textContent ?? '').join(''); }
    setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'id') this.id = String(v); if (k === 'class') this.className = String(v); }
    getAttribute(k) { if (k === 'id') return this.id || null; if (k === 'class') return this.className || null; return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; }
    addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
    dispatchEvent(ev) { for (const fn of this.listeners[ev?.type] ?? []) fn({ ...ev, target: this, stopPropagation() {}, preventDefault() {} }); }
    append(...xs) {
        for (const x of xs.flat()) {
            if (x == null || x === false) continue;
            if (typeof x !== 'object') { const t = this.ownerDocument.createElement('span'); t.textContent = String(x); t.parent = this; this.children.push(t); }
            else { x.parent = this; this.children.push(x); }
        }
    }
    prepend(x) { if (!x) return; x.parent = this; this.children.unshift(x); }
    remove() { if (this.parent) this.parent.children = this.parent.children.filter(c => c !== this); this.parent = null; }
    replaceChildren(...xs) { this.children = []; this._text = ''; this.append(...xs); }
    get isConnected() { let p = this; while (p) { if (p === this.ownerDocument) return true; p = p.parent; } return false; }
    closest(sel) { let p = this; while (p && p !== this.ownerDocument) { if (matchOne(p, sel)) return p; p = p.parent; } return null; }
    querySelectorAll(sel) { const out = [], parts = sel.trim().split(/\s+/); const walk = n => { for (const c of n.children ?? []) { if (matchesDesc(c, parts)) out.push(c); walk(c); } }; walk(this); return out; }
    querySelector(sel) { return this.querySelectorAll(sel)[0] ?? null; }
    click() { for (const fn of this.listeners.click ?? []) fn({ stopPropagation() {}, preventDefault() {}, target: this, type: 'click' }); }
}
function makeDoc() {
    const doc = new El(null, 'document');
    doc.ownerDocument = doc;
    doc.createElement = tag => new El(doc, tag);
    doc.createTextNode = text => { const t = new El(doc, 'text'); t.textContent = String(text ?? ''); return t; };
    doc.defaultView = {};
    doc.documentElement = doc.createElement('html');
    doc.body = doc.createElement('body');
    doc.append(doc.documentElement);
    const chat = doc.createElement('div');
    chat.id = 'chat';
    const mes = doc.createElement('div');
    mes.className = 'mes';
    mes.setAttribute('mesid', '0');
    mes.append(Object.assign(doc.createElement('div'), { className: 'extraMesButtons' }));
    chat.append(mes);
    doc.append(chat);
    return doc;
}
class Chan {
    static all = [];
    constructor(name) { this.name = name; this.listeners = []; Chan.all.push(this); }
    addEventListener(type, fn) { if (type === 'message') this.listeners.push(fn); }
    postMessage(data) { for (const ch of Chan.all) if (ch !== this && ch.name === this.name) for (const fn of [...ch.listeners]) fn({ data }); }
    close() {}
}
const flush = () => new Promise(r => setTimeout(r, 30));
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
    ext.settings().reporterTools = true;
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
    assert.match(card.textContent, /Lasting body/);
    assert.doesNotMatch(card.textContent, /Lasting body \(before unresolved\)/);
    assert.match(card.textContent, /a towering woman/);
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
        decideNpc: spec => gui.postMessage({ type: 'npc_decide', chatId: 'c1', req: 3, identity: spec.identity, decisionRev: spec.decisionRev, action: spec.action, payload: {} }),
        chatAt: () => ({ msg: 0, swipe: 0 }),
        placeName: a => a,
    });
    await panel.refresh();
    panel.selectId('hesk', 'changes');
    const off = panel.el.querySelectorAll('button').find(b => b.textContent === 'Turn off');
    const undo = panel.el.querySelectorAll('button').find(b => b.textContent === 'Undo');
    assert.ok(off);
    assert.ok(undo);
    assert.equal(panel.el.querySelectorAll('button').some(b => b.textContent === 'Approve'), false);
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
        ['partial', '{"body":"only a body"}'],
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
        decideNpc: spec => gui.postMessage({ type: 'npc_decide', chatId: 'c1', req: 11, ...spec }),
        chatAt: () => ({ msg: 0, swipe: 0 }),
        placeName: a => a,
    });
    await panel.refresh();
    panel.selectId('hesk', 'changes');
    const approve = panel.el.querySelectorAll('button').find(b => b.textContent === 'Approve');
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
    assert.equal(panel.el.querySelectorAll('button').some(b => b.textContent === 'Approve'), false);
    assert.ok(panel.el.querySelectorAll('button').some(b => b.textContent === 'Turn off'));
});

test('inline Edit fills the layer text, and a failed or late edit leaves the committed owner', async () => {
    const { c, prompts } = boot();
    const o = commit(appearance({ intent: 'taller', fields: 'body', layer: { body: 'original edit' }, owner: 'ed1' }));
    c.chat = [msg([o])];
    const doc = makeDoc();
    globalThis.document = doc;
    renderPatchCards();
    byText(doc, '.worldscrawl_card_btn', 'Edit').click();
    const boxes = doc.querySelectorAll('input');
    const layer = boxes.find(b => b.placeholder === 'Layer body');
    assert.ok(layer);
    assert.equal(layer.value, 'original edit');
    layer.value = 'a cropped frame';
    byText(doc, '.worldscrawl_card_btn', 'Save').click();
    await flush();
    assert.equal(o.committed.layer.body, 'original edit');
    assert.equal(o.candidate.phase, 'review');
    assert.equal(o.candidate.layer.body, 'a cropped frame');
    assert.equal(o.candidate.lastingPreview.body, 'a cropped frame');
    assert.equal(prompts.filter(p => /Rewrite body/.test(p)).length, 0);
    renderPatchCards();
    assert.match(doc.textContent, /a cropped frame/);
    assert.doesNotMatch(doc.querySelector('.worldscrawl_npcpending')?.textContent ?? '', /^Preparing/);

    o.candidate = null;
    o.decisionRev = 1;
    prompts.length = 0;
    c.generateRaw = async () => 'not json';
    renderPatchCards();
    byText(doc, '.worldscrawl_card_btn', 'Edit').click();
    doc.querySelectorAll('input').find(b => b.placeholder === 'Layer body').value = '';
    byText(doc, '.worldscrawl_card_btn', 'Save').click();
    await flush();
    assert.equal(o.committed.layer.body, 'original edit');
    assert.equal(o.candidate.phase, 'failed');

    o.candidate = null;
    o.decisionRev = 1;
    let release;
    c.generateRaw = () => new Promise(r => { release = r; });
    renderPatchCards();
    byText(doc, '.worldscrawl_card_btn', 'Edit').click();
    doc.querySelectorAll('input').find(b => b.placeholder === 'Layer body').value = '';
    byText(doc, '.worldscrawl_card_btn', 'Save').click();
    await flush();
    const dropped = await scene.settleNpc(c.chat, o.identity, o.decisionRev, 'discard', {});
    release('{"body":"late crop","outfit":"wool"}');
    await flush();
    assert.equal(dropped.ok, true);
    assert.equal(o.committed.layer.body, 'original edit');
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
    assert.equal(refused.refill, true);
    assert.equal(moved.committed, null);
    assert.equal(prompts.filter(p => /Rewrite body/.test(p)).length, 0);
    const wrong = scene.decideNpc(c.chat, { ...moved.identity, domain: 'place' }, moved.decisionRev, 'approve', { token: 'nope', elapsed: 0 });
    assert.equal(wrong.stale, true);
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
