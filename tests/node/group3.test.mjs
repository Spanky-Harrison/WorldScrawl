// Group 3: the schedule editor polish. The entry editor (castpanel drawSched) now has one shared entry builder with a grid
// layout, one "where" slot (the chooser on the map; the off-map name and Near boxes off it), tooltips and importance labels,
// a `Display Name - engine:id` chooser label, and a might-be-at list of picked places with a percent each (the map's
// multi-pick mode). Everything runs through the real handlers: the real world server behind the cast panel's io, castPanel and
// pickField/pickList on fakedom, the real chat editor (chatStamps -> npcChatEdit) and the real Remember card. fakedom has no
// layout, so the width checks are in the e2e (tests/e2e/parts/11-cast.part). Every test boots a fresh chat.
import './ststub.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { RIVERTON, TAVERN, copytree, tmpPath, write, clientDir } from './helpers.mjs';
import { validateRecord } from '../../plugin/npc.mjs';
import { mightTable } from '../../plugin/shared/npc.mjs';
import { formWarnings, formProblems, formFromRecord, formFromPlay, recordFromForm, placeResolver, MIGHT_HELP, IMPORTANCE_HELP, splitOptions } from '../../plugin/ui/castdata.mjs';
import { pickEntries, pickValid, pickSearch, pickField, pickList, placeLine, optionChips, chipsToLine, pathOf } from '../../plugin/ui/picker.mjs';
import { makeDoc } from './fakedom.mjs';

const ext = await import('../../extension/index.js');
const NPC = await import('../../extension/npc.mjs');
const scene = await import('../../extension/scene.mjs');
const { renderPatchCards } = await import('../../extension/waits.mjs');
const { exitsCache } = await import('../../extension/footer.mjs');
const { rememberWorlds, loadCalendar } = await import('../../extension/clock.mjs');
const { castPanel } = await import('../../plugin/ui/castpanel.mjs');
await loadCalendar();
const { NPC_KEY, framesOf, presentAt, scheduleAt } = NPC;

const PROMPTS = JSON.parse(fs.readFileSync(new URL('../../plugin/prompts/default.json', import.meta.url), 'utf8'));
const BAR = TAVERN, RAT = 'riverton:drowned_rat', CELLAR = `${RAT}/cellar`, YARD = `${RAT}/courtyard`, NOOK = `${RAT}/storage_nook`;
const SQ = 'riverton:streets/square', LANE = 'riverton:streets/market_lane', STORE = 'riverton:general_store/shop', STREETS = 'riverton:streets';
const SMITHY = 'riverton:smithy', FORGE = 'riverton:smithy/forge';
const H = (h, m = 0) => h * 60 + m;
const flush = (ms = 30) => new Promise(r => setTimeout(r, ms));

// ---- the harness (the shape of group2.test.mjs)
const servers = new Map();
function serverFor(cards) {
    const key = JSON.stringify(cards);
    if (servers.has(key)) return servers.get(key);
    const d = tmpPath();
    copytree(path.dirname(RIVERTON), d);
    for (const card of cards) write(path.join(d, 'riverton', 'cast', `${card.id}.json`), JSON.stringify(card, null, 2));
    const sv = { server: clientDir(d), dir: path.join(d, 'riverton') };
    servers.set(key, sv);
    return sv;
}
function boot({ time = '10:00', cards = [], here = BAR } = {}) {
    exitsCache.clear();
    const { server, dir } = serverFor(cards);
    globalThis.BroadcastChannel = undefined;
    globalThis.document = { querySelector: () => null, querySelectorAll: () => [], getElementById: () => null, createElement: () => ({ style: {}, append() {}, appendChild() {} }), body: {}, documentElement: {} };
    globalThis.fetch = async (url, opts = {}) => {
        const u = new URL(String(url), 'http://local');
        const r = server.request(opts.method || 'GET', u.pathname.replace(/^\/api\/plugins\/worldscrawl/, '') + u.search, { json: opts.body ? JSON.parse(opts.body) : undefined });
        return { ok: r.status_code < 400, status: r.status_code, headers: { get: k => r.headers.get(k) }, json: async () => r.json() };
    };
    ext.setPrompts(PROMPTS);
    const worlds = server.get('/worlds').json();
    for (const w of worlds.worlds) w.start_date = { ...w.start_date, time };
    rememberWorlds(worlds);
    const c = SillyTavern.getContext();
    c.chatId = 'group3'; c.getCurrentChatId = () => 'group3';
    c.chatMetadata = { worldscrawl_enabled: true };
    c.saveChat = async () => {}; c.saveSettingsDebounced = () => {}; c.updateMessageBlock = () => {};
    const blocks = {};
    c.setExtensionPrompt = (key, text) => { blocks[key] = String(text ?? ''); };
    c.registerFunctionTool = () => {}; c.unregisterFunctionTool = () => {};
    c.generateRaw = async args => (/Reply with JSON only:\n\{"place"/.test(String(args?.prompt ?? '')) ? '{"place": null, "people": [], "wait": null}' : '');
    Object.assign(ext.settings(), { flagNpcs: true, flagTags: true, autoKeep: false });
    c.chat = [{ is_user: false, mes: 'A quiet morning.', swipe_id: 0, swipe_info: [{ extra: {} }], extra: { worldscrawl_world: { id: 'riverton', name: 'Riverton' }, worldscrawl_location: here } }];
    return { c, blocks, server, dir };
}
const envOf = c => scene.npcEnv(c.chat, { address: c.chat.findLast?.(m => m.extra?.worldscrawl_location)?.extra.worldscrawl_location ?? BAR });
const cast = () => scene.castPack().npcs;
const folded = (c, id) => framesOf(c.chat, c.chat.length - 1, cast(), envOf(c).clock).at(-1).get(id);
const day0 = c => envOf(c).clock(0).day;
const stampsOf = (m, type) => (m.extra?.[NPC_KEY] ?? []).filter(s => s.type === type);

/** The real outline (what the map window sends the cast panel), optionally with a room made in play added to The Drowned Rat. */
const outlineOf = (server, { nook = false } = {}) => {
    const o = server.post('/edit/outline?world=riverton', { json: { changes: [] } }).json();
    if (nook) o.regions.find(r => r.id === 'riverton').subregions.find(s => s.id === 'drowned_rat').rooms.push({ address: NOOK, name: 'Storage Nook' });
    return o;
};
/** The cast panel over the real world server. wsPick is a stub that mirrors the real return rules (a string, or an array for multi). */
function panelFor(server, { outline = null, play = null, chatAt = null, chatEdit = null, picks = [] } = {}) {
    const doc = makeDoc();
    const saved = [], specs = [];
    doc.defaultView.wsPick = async spec => {
        specs.push(spec);
        const next = picks.shift();
        if (next === undefined) return null;
        if (spec.multi) return next === null ? null : [].concat(next);
        return next === null ? null : String(next);
    };
    const panel = castPanel(doc, {
        load: async () => server.get('/cast?world=riverton').json(), outline: async () => outline, play: () => play?.() ?? null, placeName: a => a,
        ...(chatAt ? { chatAt } : {}), ...(chatEdit ? { chatEdit } : {}),
        save: async (npc, original, originalFile) => { saved.push(npc); const res = server.post('/cast/save?world=riverton', { json: { npc, ...(original ? { original } : {}), ...(originalFile ? { original_file: originalFile } : {}) } }); if (res.status_code >= 400) throw new Error(res.json()?.error ?? 'save failed'); return res.json(); },
    });
    return { panel, doc, saved, specs, picks };
}
const rowsOf = panel => panel.el.querySelectorAll('.cf-sched');
const hesk = async (server, opts = {}) => { const p = panelFor(server, opts); await p.panel.refresh(); p.panel.selectId('hesk', 'resolved'); p.panel.el.querySelectorAll('.cast-saveas')[0].click(); return p; };
const confirmSave = async panel => { panel.el.querySelectorAll('.cast-save')[0].click(); panel.el.querySelectorAll('.cast-confirm')[0].click(); await flush(60); };
const click = el => el.dispatchEvent({ type: 'click' });
const errs = panel => panel.el.querySelectorAll('.cf-err').map(e => e.textContent).filter(Boolean).join(' | ');
const warns = panel => panel.el.querySelectorAll('.cf-warn').map(e => e.textContent).filter(Boolean).join(' | ');
const lastFile = (dir, known) => fs.readdirSync(path.join(dir, 'cast')).find(x => !known.includes(x));
const savedAsNew = (dir, known = ['hesk.json', 'tam.json', 'bryn.json']) => { const f = lastFile(dir, known); const rec = JSON.parse(fs.readFileSync(path.join(dir, 'cast', f), 'utf8')); fs.rmSync(path.join(dir, 'cast', f)); return rec; };

// ---- 1. the pure picker helpers
test('optionChips / chipsToLine: every grammar case round-trips byte for byte, with the shared odds table shares', () => {
    const { server } = boot();
    const resolve = placeResolver(server.get('/cast?world=riverton').json(), outlineOf(server));
    const cases = [
        [`${LANE}, nowhere(80)`, [['room', null], ['nowhere', 80]], [20, 80]],
        ['riverton:a, riverton:b, riverton:c', null, [34, 33, 33]],
        [`${LANE}(10), ${SQ}(10), ${STORE}(10)`, [['room', 10], ['room', 10], ['room', 10]], [10, 10, 10]],
        [`${SMITHY}(60), riverton(40)`, [['area', 60], ['region', 40]], [60, 40]],
        ['a fishing camp up the river(30), riverton:smithy', [['text', 30], ['area', null]], [30, 70]],
        [`${LANE}(70), ${SQ}(50)`, [['room', 70], ['room', 50]], [70, 50]],
    ];
    for (const [line, kinds, shares] of cases) {
        const chips = optionChips(line, resolve);
        assert.equal(chipsToLine(chips), line, `round trip: ${line}`);
        if (kinds) assert.deepEqual(chips.map(c => [c.kind, c.pct]), kinds, line);
        assert.deepEqual(chips.map(c => c.share), shares, `shares of ${line}`);
        assert.deepEqual(chips.table, mightTable(splitOptions(line).filter(o => o.text).map(o => ({ text: o.text, pct: o.pct }))), 'the table is the shared one');
    }
    assert.equal(optionChips(`${LANE}(70), ${SQ}(50)`, resolve).table.broken, true, 'over 100 is the existing broken table');
    // A malformed token is shown raw; an ambiguous name and an unknown address are flagged; a stub and words are off the map.
    const odd = optionChips('a, b(150)', resolve);
    assert.deepEqual(odd.map(c => c.kind), ['text', 'bad']);
    assert.equal(chipsToLine(odd), 'a, b(150)');
    assert.equal(optionChips("Marlow's General Store", resolve)[0].kind, 'ambiguous');
    assert.equal(optionChips('riverton:nope/room', resolve)[0].kind, 'unknown');
    assert.deepEqual(optionChips('wickerton, nowhere', resolve).map(c => [c.kind, c.id ?? null]), [['stub', 'wickerton'], ['nowhere', null]]);
    assert.equal(optionChips(RAT, resolve)[0].tag, 'area');
    assert.equal(optionChips('riverton', resolve)[0].tag, 'region');
    assert.equal(optionChips(LANE, resolve)[0].tag, 'place');
    // A legacy typed name resolves: its chip shows the address and keeps the typed text in the line.
    const legacy = optionChips('Market Lane(30), Village Square', resolve);
    assert.deepEqual(legacy.map(c => c.id), [LANE, SQ]);
    assert.equal(chipsToLine(legacy), 'Market Lane(30), Village Square');
});
test('pickEntries / pickValid / pickSearch: an array of kinds finds rooms, areas and regions; a string kind behaves as before; exclude refuses an id everywhere', () => {
    const { server } = boot();
    const outline = outlineOf(server);
    const kinds = ['room', 'subregion', 'region'];
    const all = pickEntries(outline, kinds);
    for (const id of [LANE, RAT, 'riverton', SMITHY]) assert.ok(all.some(e => e.id === id), id);
    assert.deepEqual(pickEntries(outline, 'region').map(e => e.id).sort(), outline.regions.map(r => r.id).sort());
    assert.ok(!pickEntries(outline, 'room').some(e => e.id === RAT), 'a string kind is exactly its own kind');
    const spec = { kind: kinds, outline, exclude: [LANE, RAT, 'riverton'] };
    for (const id of [LANE, RAT, 'riverton']) assert.equal(pickValid(spec, id), false, `${id} is excluded`);
    assert.equal(pickValid(spec, SQ), true);
    assert.equal(pickValid({ kind: 'room', outline }, RAT), false, 'single kind: an area is not a room');
    const hits = pickSearch(spec, 'market lane');
    assert.ok(hits.length && hits.every(h => h.valid === false || h.id !== LANE), 'search shows the excluded one as not valid');
    assert.equal(hits.find(h => h.id === LANE)?.valid, false);
    assert.equal(pickSearch({ ...spec, exclude: [] }, 'market lane').find(h => h.id === LANE)?.valid, true);
    assert.ok(pickSearch(spec, 'drowned rat').some(h => h.id === RAT && h.kind === 'subregion'), 'search results carry their own kind');
});

// ---- 2. the label
test('pickField label nameId: "Name - engine:id" on one line, the id selectable, the path in the tooltip; no outline falls back to the name, then the id; the default field still shows the path', () => {
    const { server } = boot();
    const outline = outlineOf(server);
    const doc = makeDoc();
    const f = pickField(doc, { kind: 'room', title: 'x', outline, value: YARD, label: 'nameId' });
    const shown = f.querySelectorAll('.wspick-value')[0];
    assert.equal(shown.textContent, `${placeLine(outline, 'room', YARD).name} - ${YARD}`);
    assert.doesNotMatch(shown.textContent, /›/);
    assert.equal(f.querySelectorAll('.wspick-id')[0].textContent, YARD);
    assert.match(shown.title, /Riverton › The Drowned Rat › /);
    const bare = pickField(doc, { kind: 'room', title: 'x', outline: null, value: YARD, label: 'nameId', nameOf: a => (a === YARD ? 'The Courtyard' : '') });
    assert.equal(bare.querySelectorAll('.wspick-value')[0].textContent, `The Courtyard - ${YARD}`);
    assert.equal(pickField(doc, { kind: 'room', title: 'x', outline: null, value: YARD, label: 'nameId' }).querySelectorAll('.wspick-value')[0].textContent, YARD, 'no name anywhere: the id alone');
    assert.equal(pickField(doc, { kind: 'room', title: 'x', outline, value: YARD }).querySelectorAll('.wspick-value')[0].textContent, pathOf(outline, 'room', YARD), 'the default field keeps the path');
    assert.equal(pickField(doc, { kind: 'room', title: 'x', outline, value: '', label: 'nameId' }).querySelectorAll('.wspick-value')[0].textContent, '(no place chosen)');
    // A pick through the stubbed wsPick updates the line and fires change once.
    doc.defaultView.wsPick = async () => SQ;
    let changes = 0;
    f.addEventListener('change', () => { changes++; });
    click(f.querySelectorAll('.wspick-choose')[0]);
    return flush(10).then(() => {
        assert.equal(f.value, SQ);
        assert.equal(f.querySelectorAll('.wspick-value')[0].textContent, `${placeLine(outline, 'room', SQ).name} - ${SQ}`);
        assert.equal(changes, 1);
    });
});

// ---- 3. the where slot
test('where slot: on the map the chooser (labelled Name - id) and no off-map boxes; Off the map removes the chooser from the DOM and shows Off-map place name and Near area; typed text survives ticking off, on, off; the file shape is never both', async () => {
    for (const mode of ['base', 'chat']) {
        const { c, server, dir } = boot({ cards: [] });
        const play = () => scene.mapNpcs(c.chat, { address: BAR });
        const at = () => ({ msg: c.chat.length - 1, swipe: 0 });
        const stamped = [];
        const p = panelFor(server, { outline: outlineOf(server), play, chatAt: at, chatEdit: async (id, stamps) => { stamped.push(...stamps); return { ok: true, count: stamps.length, msg: 0 }; } });
        await p.panel.refresh();
        p.panel.selectId('hesk', 'resolved');
        if (mode === 'base') p.panel.el.querySelectorAll('.cast-saveas')[0].click(); else p.panel.el.querySelectorAll('.cast-edit')[0].click();
        const row = () => rowsOf(p.panel)[0];
        assert.ok(row().querySelectorAll('.wspick').length === 1, `${mode}: the chooser on the map`);
        assert.match(row().querySelectorAll('.wspick-value')[0].textContent, / - riverton:drowned_rat\/common_room$/);
        assert.equal(row().querySelectorAll('.cf-where').length + row().querySelectorAll('.cf-near').length, 0);
        assert.equal(row().querySelectorAll('.cf-offmap')[0].checked, false);
        const off = () => row().querySelectorAll('.cf-offmap')[0];
        off().checked = true; off().dispatchEvent({ type: 'change' });
        assert.equal(row().querySelectorAll('.wspick').length, 0, `${mode}: the chooser is gone, not hidden`);
        assert.equal(row().textContent.includes('Place'), false);
        const wh = row().querySelectorAll('.cf-where')[0], nr = row().querySelectorAll('.cf-near')[0];
        assert.deepEqual([wh.getAttribute('placeholder'), nr.getAttribute('placeholder')], ['Off-map place name', 'Near area']);
        wh.value = 'her own room'; wh.dispatchEvent({ type: 'input' }); nr.value = RAT; nr.dispatchEvent({ type: 'input' });
        off().checked = false; off().dispatchEvent({ type: 'change' });
        assert.equal(row().querySelectorAll('.wspick').length, 1);
        assert.equal(row().querySelectorAll('.cf-where').length, 0);
        assert.match(errs(p.panel), /Choose a place on the map, or tick Off the map\./, 'empty place on the map still blocks Save');
        assert.equal(p.panel.el.querySelectorAll('.cast-save')[0].disabled, true);
        off().checked = true; off().dispatchEvent({ type: 'change' });
        assert.equal(row().querySelectorAll('.cf-where')[0].value, 'her own room', 'typed text survived off, on, off');
        assert.equal(row().querySelectorAll('.cf-near')[0].value, RAT);
        if (mode === 'base') {
            await confirmSave(p.panel);
            const rec = savedAsNew(dir);
            const e = rec.schedule[0];
            assert.deepEqual([e.where, e.near, 'place' in e], ['her own room', RAT, false], 'off the map: where and near, never a place');
            assert.equal(rec.schedule[1].place === undefined, true);
        } else {
            p.panel.el.querySelectorAll('.cast-save')[0].click();
            assert.match(p.panel.el.querySelector('.cast-review').textContent, /Stamps to add in this chat/);
        }
    }
});
test('where slot: an on-map entry saves a place and never where/near (the old values stay out of the file)', async () => {
    const { server, dir } = boot();
    const p = await hesk(server, { outline: outlineOf(server) });
    const row = rowsOf(p.panel)[0];
    const off = row.querySelectorAll('.cf-offmap')[0];
    off.checked = true; off.dispatchEvent({ type: 'change' });
    const wh = rowsOf(p.panel)[0].querySelectorAll('.cf-where')[0]; wh.value = 'somewhere'; wh.dispatchEvent({ type: 'input' });
    const off2 = rowsOf(p.panel)[0].querySelectorAll('.cf-offmap')[0];
    off2.checked = false; off2.dispatchEvent({ type: 'change' });
    p.doc.defaultView.wsPick = async () => BAR;
    click(rowsOf(p.panel)[0].querySelectorAll('.wspick-choose')[0]);
    await flush(10);
    assert.equal(errs(p.panel), '');
    await confirmSave(p.panel);
    const e = savedAsNew(dir).schedule[0];
    assert.equal(e.place, BAR);
    assert.equal('where' in e || 'near' in e, false);
});

// ---- 4. importance and tooltips
test('importance and tooltips: blank labels per kind (switching with the kind), blank writes no importance, a chosen value is written, every control has a title or placeholder, the notes use the new names', async () => {
    const { server, dir } = boot();
    const p = await hesk(server, { outline: outlineOf(server) });
    const { panel } = p;
    const imp = i => rowsOf(panel)[i].querySelectorAll('.cf-importance')[0];
    const first = el => el.children[0].textContent;
    assert.equal(first(imp(0)), '(judge from activity)', 'Is at');
    assert.equal(first(imp(2)), '(low)', 'Might be at');
    assert.match(imp(0).getAttribute('title'), /blank/i);
    assert.match(imp(0).getAttribute('title'), /low/);
    assert.equal(imp(0).getAttribute('title'), IMPORTANCE_HELP);
    assert.match(IMPORTANCE_HELP, /does not change where they turn up/, 'honest about what it does today');
    const kind = () => rowsOf(panel)[2].querySelectorAll('.cf-kind')[0];
    kind().value = 'at'; kind().dispatchEvent({ type: 'change' });
    assert.equal(first(imp(2)), '(judge from activity)', 'the label switched with the kind');
    kind().value = 'might'; kind().dispatchEvent({ type: 'change' });
    assert.equal(first(imp(2)), '(low)');
    // Every control in every entry (both kinds) has a title or a placeholder.
    const bare = [];
    const off = rowsOf(panel)[1].querySelectorAll('.cf-offmap')[0]; assert.ok(off);
    for (const r of rowsOf(panel)) for (const el of [...r.querySelectorAll('input'), ...r.querySelectorAll('select'), ...r.querySelectorAll('button')]) {
        if (!(el.getAttribute('title') || el.getAttribute('placeholder') || el.title)) bare.push(`${el.tag}.${el.className}`);
    }
    assert.deepEqual(bare, []);
    // The off-map row (Hesk's asleep entry) shows the named boxes with tooltips too.
    const asleep = rowsOf(panel)[1];
    assert.match(asleep.querySelectorAll('.cf-where')[0].getAttribute('title'), /her own room/);
    assert.match(asleep.querySelectorAll('.cf-near')[0].getAttribute('title'), /off-map list/);
    assert.match(panel.el.textContent, /an off-map place name and the area it is near/);
    assert.doesNotMatch(panel.el.textContent, /where they are and what that is near/);
    assert.match(MIGHT_HELP, /Wandering moves them every 15 to 60 minutes/);
    // Blank importance writes no key on either kind; a chosen value is written.
    imp(2).value = 'normal'; imp(2).dispatchEvent({ type: 'change' });
    imp(1).value = 'low'; imp(1).dispatchEvent({ type: 'change' });
    await confirmSave(panel);
    const rec = savedAsNew(dir);
    assert.deepEqual(rec.schedule.map(e => e.importance ?? null), ['high', 'low', 'normal', null, null]);
    assert.equal(rec.schedule[0].importance, 'high');
});

// ---- 5. the might-be-at list
const HESK_FILE = () => JSON.parse(fs.readFileSync(path.join(RIVERTON, 'cast', 'hesk.json'), 'utf8'));
const chipsIn = (panel, i) => rowsOf(panel)[i].querySelectorAll('.cf-chip');
const chipText = chip => chip.querySelectorAll('.cf-chiplabel')[0].textContent;
const typedBox = (panel, i) => rowsOf(panel)[i].querySelectorAll('.cf-options')[0];
const MIGHT_ROW = 3; // Hesk's "seeing to the inn" block: one area option

test('might list: Hesk\'s stored area option is one area chip with Name - id; Add place… adds a room, an area and a region in order; percent, Nowhere, off the map and remove all rewrite the one options string; the file written equals the list', async () => {
    const { server, dir } = boot();
    const p = await hesk(server, { outline: outlineOf(server), picks: [] });
    const { panel, specs } = p;
    assert.equal(chipsIn(panel, MIGHT_ROW).length, 1);
    assert.equal(chipText(chipsIn(panel, MIGHT_ROW)[0]), `The Drowned Rat - ${RAT}`);
    assert.equal(chipsIn(panel, MIGHT_ROW)[0].getAttribute('data-kind'), 'area');
    assert.equal(chipsIn(panel, MIGHT_ROW)[0].querySelectorAll('.cf-chiptag')[0].textContent, 'area');
    assert.equal(rowsOf(panel)[MIGHT_ROW].querySelectorAll('.cf-total')[0].textContent, 'Total 100%.');
    assert.equal(typedBox(panel, MIGHT_ROW).value, 'The Drowned Rat', 'the text box still shows names where they are unique');
    // Add place…: the map gets the multi spec; the stub returns a room, an area and a region.
    p.picks.push([SQ, SMITHY, 'riverton']);
    click(rowsOf(panel)[MIGHT_ROW].querySelectorAll('.cf-addplace')[0]);
    await flush(10);
    assert.deepEqual(specs.at(-1).kind, ['room', 'subregion', 'region']);
    assert.equal(specs.at(-1).multi, true);
    assert.deepEqual(specs.at(-1).exclude, [RAT]);
    const chips = () => chipsIn(panel, MIGHT_ROW);
    assert.deepEqual(chips().map(c => c.getAttribute('data-kind')), ['area', 'room', 'area', 'region']);
    assert.deepEqual(chips().map(c => c.querySelectorAll('.cf-chiptag')[0].textContent), ['area', 'place', 'area', 'region']);
    assert.match(chipText(chips()[1]), new RegExp(` - ${SQ}$`));
    assert.match(chipText(chips()[3]), / - riverton$/);
    // The odds: four unnumbered options split 100 (25 each); the placeholders show the shares.
    assert.deepEqual(chips().map(c => c.querySelectorAll('.cf-pct')[0].getAttribute('placeholder')), ['25', '25', '25', '25']);
    // A percent on the second: the string, the Total line and the review follow.
    const pct = i => chips()[i].querySelectorAll('.cf-pct')[0];
    pct(1).value = '20'; pct(1).dispatchEvent({ type: 'input' });
    assert.equal(typedBox(panel, MIGHT_ROW).value, `The Drowned Rat, ${SQ}(20), ${SMITHY}, riverton`, 'the text box shows names where they are unique');
    assert.equal(rowsOf(panel)[MIGHT_ROW].querySelectorAll('.cf-total')[0].textContent, 'Total 100%.');
    pct(1).dispatchEvent({ type: 'change' });
    assert.deepEqual(chips().map(c => c.querySelectorAll('.cf-pct')[0].getAttribute('placeholder')), ['28', '20', '26', '26'], 'blank percents share the rest: 80 over three, the remainder to the first');
    // Add Nowhere (once): the button disables.
    const nowhereBtn = () => rowsOf(panel)[MIGHT_ROW].querySelectorAll('.cf-addnowhere')[0];
    click(nowhereBtn());
    assert.equal(nowhereBtn().disabled, true);
    click(nowhereBtn());
    assert.equal(chips().filter(c => c.getAttribute('data-kind') === 'nowhere').length, 1);
    assert.equal(chipText(chips().at(-1)), 'Nowhere');
    // Add off the map with a stub id, then with free words.
    const addOff = async text => {
        click(rowsOf(panel)[MIGHT_ROW].querySelectorAll('.cf-addoff')[0]);
        const inp = rowsOf(panel)[MIGHT_ROW].querySelectorAll('.cf-offname')[0];
        inp.value = text; click(rowsOf(panel)[MIGHT_ROW].querySelectorAll('.cf-offadd')[0]);
    };
    await addOff('Wickerton');
    await addOff('a fishing camp up the river');
    assert.equal(typedBox(panel, MIGHT_ROW).value, `The Drowned Rat, ${SQ}(20), ${SMITHY}, riverton, nowhere, wickerton, a fishing camp up the river`);
    assert.deepEqual(chips().slice(-2).map(c => c.getAttribute('data-kind')), ['stub', 'text']);
    assert.match(chipText(chips().at(-2)), /Wickerton - wickerton$/);
    // Remove a chip (the region), then edit the text box and blur: the chips follow.
    click(chips()[3].querySelectorAll('.cf-chipx')[0]);
    assert.equal(typedBox(panel, MIGHT_ROW).value, `The Drowned Rat, ${SQ}(20), ${SMITHY}, nowhere, wickerton, a fishing camp up the river`);
    typedBox(panel, MIGHT_ROW).value = `${RAT}(50), ${LANE}, nowhere(10)`;
    typedBox(panel, MIGHT_ROW).dispatchEvent({ type: 'input' });
    typedBox(panel, MIGHT_ROW).dispatchEvent({ type: 'change' });
    assert.deepEqual(chips().map(c => c.getAttribute('data-kind')), ['area', 'room', 'nowhere']);
    assert.equal(chips()[0].querySelectorAll('.cf-pct')[0].value, '50');
    assert.equal(errs(panel), '');
    // Wandering and Anywhere are still written when ticked; the file equals the list.
    rowsOf(panel)[MIGHT_ROW].querySelectorAll('.cf-wandering')[0].checked = true; rowsOf(panel)[MIGHT_ROW].querySelectorAll('.cf-wandering')[0].dispatchEvent({ type: 'change' });
    rowsOf(panel)[MIGHT_ROW].querySelectorAll('.cf-anywhere')[0].checked = true; rowsOf(panel)[MIGHT_ROW].querySelectorAll('.cf-anywhere')[0].dispatchEvent({ type: 'change' });
    await confirmSave(panel);
    assert.equal(p.saved.length, 1);
    assert.deepEqual(p.saved[0].schedule[MIGHT_ROW], { might: [`${RAT}(50)`, LANE, 'nowhere(10)'], activity: 'seeing to the inn', from: '13:00', to: '15:00', wandering: true, anywhere: true });
    assert.deepEqual(savedAsNew(dir).schedule[MIGHT_ROW].might, [`${RAT}(50)`, LANE, 'nowhere(10)']);
});
test('might list: an untouched row is its authored entry (key order kept); Anywhere with no area chip still saves; over 100% blocks with the existing message and outlines the chips', async () => {
    const { server, dir } = boot();
    const p = await hesk(server, { outline: outlineOf(server) });
    const { panel } = p;
    await confirmSave(panel);
    assert.equal(JSON.stringify(p.saved[0].schedule), JSON.stringify(HESK_FILE().schedule), 'every row, untouched, goes out as written');
    savedAsNew(dir);
    const q = await hesk(server, { outline: outlineOf(server) });
    const row = i => rowsOf(q.panel)[i];
    // Anywhere on the row with only room chips: no new rule, it saves.
    row(2).querySelectorAll('.cf-anywhere')[0].checked = true; row(2).querySelectorAll('.cf-anywhere')[0].dispatchEvent({ type: 'change' });
    assert.equal(q.panel.el.querySelectorAll('.cast-save')[0].disabled, false);
    // Over 100.
    const pcts = [...row(MIGHT_ROW).querySelectorAll('.cf-pct')];
    pcts[0].value = '70'; pcts[0].dispatchEvent({ type: 'input' });
    q.picks.push([SQ]);
    click(row(MIGHT_ROW).querySelectorAll('.cf-addplace')[0]); await flush(10);
    const second = row(MIGHT_ROW).querySelectorAll('.cf-pct')[1];
    second.value = '50'; second.dispatchEvent({ type: 'input' });
    assert.match(errs(q.panel), /The odds add up to 120%, over 100\./);
    assert.equal(q.panel.el.querySelectorAll('.cast-save')[0].disabled, true);
    assert.match(row(MIGHT_ROW).querySelectorAll('.cf-picklist')[0].className, /\bover\b/);
    assert.match(row(MIGHT_ROW).querySelectorAll('.cf-total')[0].textContent, /over 100/);
});
test('might list: an ambiguous typed name and a malformed token show as flagged chips with the existing errors', async () => {
    const { server } = boot();
    const p = await hesk(server, { outline: outlineOf(server) });
    typedBox(p.panel, MIGHT_ROW).value = "Marlow's General Store, a(150)"; typedBox(p.panel, MIGHT_ROW).dispatchEvent({ type: 'input' }); typedBox(p.panel, MIGHT_ROW).dispatchEvent({ type: 'change' });
    assert.deepEqual(chipsIn(p.panel, MIGHT_ROW).map(c => c.getAttribute('data-kind')), ['ambiguous', 'bad']);
    assert.match(errs(p.panel), /Not an option: a\(150\)/);
    typedBox(p.panel, MIGHT_ROW).value = "Marlow's General Store"; typedBox(p.panel, MIGHT_ROW).dispatchEvent({ type: 'input' });
    assert.match(errs(p.panel), /matches .* Use the address/);
    assert.match(chipsIn(p.panel, MIGHT_ROW)[0].className, /\bbad\b/);
});

// ---- 5b. no duplicates
test('duplicates: Add place… excludes the listed ids, a stub that returns one adds no second chip; typed duplicates warn once and never block or rewrite the file; the server load note says it too', async () => {
    const { server, dir } = boot();
    const p = await hesk(server, { outline: outlineOf(server) });
    const { panel, specs } = p;
    p.picks.push([RAT, SQ, SQ]);
    click(rowsOf(panel)[MIGHT_ROW].querySelectorAll('.cf-addplace')[0]); await flush(10);
    assert.deepEqual(specs.at(-1).exclude, [RAT], 'the map gets the current chips as exclude');
    assert.deepEqual(chipsIn(panel, MIGHT_ROW).map(c => c.querySelectorAll('.cf-chiplabel')[0].textContent.split(' - ').at(-1)), [RAT, SQ], 'the stub returned a listed id and a repeat: neither added twice');
    // The real pickValid/pickSearch refuse an excluded id (the map's button, double-click and search all go through them).
    const o = outlineOf(server);
    const spec = { kind: ['room', 'subregion', 'region'], outline: o, exclude: specs.at(-1).exclude };
    assert.equal(pickValid(spec, RAT), false);
    assert.equal(pickSearch(spec, 'drowned rat').find(h => h.id === RAT)?.valid, false);
    assert.equal(pickValid(spec, SQ), true, 'the one the stub returned is excluded on the next open');
    // Typed duplicates: exactly one warning each, Save stays enabled.
    const dup = /is listed twice; their shares add up\. Remove one\./g;
    for (const [line, who] of [[`${LANE}, ${LANE}`, 'Market Lane'], [`Market Lane, ${LANE}`, 'Market Lane'], ['nowhere, nowhere(20)', 'Nowhere'], [`${RAT}, ${RAT}(30)`, 'The Drowned Rat']]) {
        typedBox(panel, MIGHT_ROW).value = line; typedBox(panel, MIGHT_ROW).dispatchEvent({ type: 'input' });
        const w = warns(panel);
        assert.equal((w.match(dup) ?? []).length, 1, `${line}: ${w}`);
        assert.ok(w.includes(`${who} is listed twice`), w);
        assert.equal(errs(panel), '', line);
        assert.equal(panel.el.querySelectorAll('.cast-save')[0].disabled, false, `${line}: a warning does not block`);
        typedBox(panel, MIGHT_ROW).dispatchEvent({ type: 'change' });
        assert.ok(chipsIn(panel, MIGHT_ROW).some(c => /\bdup\b/.test(c.className)), 'the duplicate chips carry the warning outline');
    }
    for (const line of ['a, b', `${LANE}(10), ${SQ}(10)`, `${LANE}, nowhere`]) {
        typedBox(panel, MIGHT_ROW).value = line; typedBox(panel, MIGHT_ROW).dispatchEvent({ type: 'input' });
        assert.doesNotMatch(warns(panel), /listed twice/, line);
    }
    // The over-100 error is unchanged for duplicates.
    typedBox(panel, MIGHT_ROW).value = `${LANE}(70), ${LANE}(50)`; typedBox(panel, MIGHT_ROW).dispatchEvent({ type: 'input' });
    assert.match(errs(panel), /add up to 120%, over 100/);
    // Saved as typed (no silent dedupe), through /cast/save; and the same file loads with the server's note.
    typedBox(panel, MIGHT_ROW).value = `${LANE}, ${LANE}`; typedBox(panel, MIGHT_ROW).dispatchEvent({ type: 'input' });
    await confirmSave(panel);
    assert.deepEqual(p.saved[0].schedule[MIGHT_ROW].might, [LANE, LANE]);
    assert.deepEqual(savedAsNew(dir).schedule[MIGHT_ROW].might, [LANE, LANE]);
    const v = validateRecord({ id: 'x', name: 'X', line: 'x', schedule: [{ might: [LANE, LANE], activity: 'x', from: '09:00', to: '10:00' }, { might: ['nowhere', 'nowhere(20)'], activity: 'y', from: '10:00', to: '11:00' }, { might: [LANE, SQ], activity: 'z', from: '11:00', to: '12:00' }] }, { file: 'x.json', places: new Set([LANE, SQ]) });
    assert.equal(v.ok, true, 'a duplicate never breaks the file');
    assert.deepEqual(v.warnings.filter(w => /listed twice/.test(w)), [`x.json schedule[0]: "${LANE}" is listed twice; their shares add up. Remove one`, 'x.json schedule[1]: "nowhere(20)" is listed twice; their shares add up. Remove one'.replace('nowhere(20)', 'nowhere')]);
});

// ---- 5c. single mode returns a string
test('single-pick contract: no pickField caller sets multi; each caller\'s spec resolves a string, sets .value to it, fires change once; Cancel leaves the value; only multi gets an array', async () => {
    // The sources: every pickField call site, none with multi.
    const dir = new URL('../../plugin/ui/', import.meta.url);
    let sites = 0;
    for (const f of ['castpanel.mjs', 'mapactions.mjs', 'placeform.mjs']) {
        for (const line of fs.readFileSync(new URL(f, dir), 'utf8').split('\n')) if (/pickField\(/.test(line)) { sites++; assert.doesNotMatch(line, /multi/, `${f}: ${line.trim().slice(0, 80)}`); }
    }
    assert.equal(sites, 9, 'the nine callers in the plan');
    const { server } = boot();
    const outline = outlineOf(server);
    // Each caller's spec (copied from the call sites), against a wsPick that mirrors the real return rules.
    const specs = {
        'castpanel place filter': { kind: 'room', title: 'place to filter by', outline, value: '', clearable: true, empty: 'Any place' },
        'castpanel Is-at chooser': { kind: 'room', title: 'place for x', outline, value: '', label: 'nameId' },
        'mapactions exit destination': { kind: 'room', title: 'exit destination', exclude: [BAR], outline, value: '' },
        'mapactions move into subregion': { kind: 'subregion', title: 'subregion to move its places into', exclude: [RAT], outline },
        'mapactions move into region': { kind: 'region', title: 'region to move its subregions into', exclude: ['larkspur'], outline },
        'mapactions move to subregion': { kind: 'subregion', title: 'subregion to move it to', exclude: [RAT], outline },
        'mapactions move to region': { kind: 'region', title: 'region to move it to', exclude: ['larkspur'], outline },
        'placeform move to subregion': { kind: 'subregion', title: 'subregion to move it to', outline, value: '' },
        'placeform exit destination': { kind: 'room', title: 'exit destination', outline, exclude: [BAR], value: '' },
    };
    const answers = { room: SQ, subregion: SMITHY, region: 'riverton' };
    for (const [who, spec] of Object.entries(specs)) {
        const doc = makeDoc();
        const seen = [];
        let answer = answers[spec.kind];
        doc.defaultView.wsPick = async s => { seen.push(s); return s.multi ? [answer] : answer; };
        const f = pickField(doc, spec);
        let changes = 0; f.addEventListener('change', () => { changes++; });
        click(f.querySelectorAll('.wspick-choose')[0]); await flush(5);
        assert.equal(seen.length, 1, who);
        assert.equal(seen[0].multi, undefined, `${who}: not a multi spec`);
        assert.equal(typeof f.value, 'string', who);
        assert.equal(f.value, answers[spec.kind], who);
        assert.equal(changes, 1, `${who}: one change event`);
        answer = null;
        doc.defaultView.wsPick = async () => null;
        click(f.querySelectorAll('.wspick-choose')[0]); await flush(5);
        assert.equal(f.value, answers[spec.kind], `${who}: Cancel leaves the value`);
        assert.equal(changes, 1);
    }
    // The cast panel's two real fields: the specs they pass, a string back.
    const { c } = boot();
    const p = await hesk(server, { outline });
    p.picks.push(SQ);
    click(rowsOf(p.panel)[0].querySelectorAll('.wspick-choose')[0]); await flush(10);
    assert.equal(p.specs.at(-1).multi, undefined);
    assert.equal(p.specs.at(-1).kind, 'room');
    assert.equal(rowsOf(p.panel)[0].querySelectorAll('.wspick')[0].value, SQ);
    // multi: true is the only spec that gets an array.
    p.picks.push(LANE);
    click(rowsOf(p.panel)[MIGHT_ROW].querySelectorAll('.cf-addplace')[0]); await flush(10);
    assert.equal(p.specs.at(-1).multi, true);
    assert.ok(c);
});

// ---- 6. the chat editor
const ASLEEP_ROW = 1;
function chatPanel({ c, server, outline, picks = [] }) {
    const stamped = [];
    const p = panelFor(server, {
        outline, picks, play: () => scene.mapNpcs(c.chat, { address: BAR }), chatAt: () => ({ msg: c.chat.length - 1, swipe: c.chat.at(-1).swipe_id ?? null }),
        chatEdit: async (id, stamps, at) => { stamped.push(...stamps); const res = await scene.npcChatEdit({ chatId: 'group3', msg: at.msg, swipe: at.swipe, id, stamps }); return { ...res, count: stamps.length }; },
    });
    return { ...p, stamped };
}
test('chat editor: an area chip, a second area and Nowhere in the chat form give one npc_schedule stamp; the sweep over a day picks only inside those areas, in this chat only; an untouched form says Nothing changed', async () => {
    const { c, server } = boot({ time: '09:00' });
    const p = chatPanel({ c, server, outline: outlineOf(server) });
    await p.panel.refresh();
    p.panel.selectId('hesk', 'resolved');
    click(p.panel.el.querySelectorAll('.cast-edit')[0]);
    assert.ok(rowsOf(p.panel).length >= 5);
    // Untouched: Nothing changed, no Confirm.
    click(p.panel.el.querySelectorAll('.cast-save')[0]);
    assert.match(p.panel.el.querySelector('.cast-review').textContent, /Nothing changed\./);
    assert.equal(p.panel.el.querySelectorAll('.cast-confirm').length, 0);
    const idx = rowsOf(p.panel).findIndex(r => r.querySelectorAll('.cf-chip').some(ch => ch.querySelectorAll('.cf-chiplabel')[0].textContent.endsWith(` - ${RAT}`)));
    assert.ok(idx >= 0, 'Hesk\'s area block is a might row with the area chip');
    p.picks.push([SMITHY]);
    click(rowsOf(p.panel)[idx].querySelectorAll('.cf-addplace')[0]); await flush(10);
    click(rowsOf(p.panel)[idx].querySelectorAll('.cf-addnowhere')[0]);
    assert.equal(typedBox(p.panel, idx).value, `The Drowned Rat, ${SMITHY}, nowhere`);
    click(p.panel.el.querySelectorAll('.cast-save')[0]);
    click(p.panel.el.querySelectorAll('.cast-confirm')[0]); await flush(80);
    assert.deepEqual(p.stamped.map(s => s.type), ['npc_schedule'], 'one stamp');
    assert.deepEqual(p.stamped[0].schedule.find(e => e.might?.includes(SMITHY)).might, [`${RAT}`, SMITHY, 'nowhere']);
    const env = envOf(c), seen = new Set();
    for (let k = 0; k < 240; k++) {
        const s = scheduleAt(folded(c, 'hesk'), { day: day0(c) + 1 + Math.floor(k / 8), minutes: H(13) + (k % 8) * 15 }, env);
        if (s.kind === 'might') seen.add(s.address === null ? null : s.address.split('/')[0]);
    }
    assert.deepEqual([...seen].sort((a, b) => String(a).localeCompare(String(b))), [null, RAT, SMITHY].sort((a, b) => String(a).localeCompare(String(b))), 'inside the two areas or away, never anywhere else');
    // A fresh chat is unchanged.
    const other = boot({ time: '09:00' }).c;
    assert.deepEqual(stampsOf(other.chat[0], 'npc_schedule'), []);
});
test('a room made in play: in the chat form it is a plain room chip with no warning; in the cast file form the same chip saves with the "this chat only" warning; an Is-at place on it is refused', async () => {
    const NOOK_PATCH = { type: 'patch', id: 'p_nook', swipe: 0, relocate: {}, summary: ['A storage nook off the common room'],
        ops: [{ op: 'create_place', area: RAT, id: 'storage_nook', name: 'Storage Nook', description: 'Shelves of jars and a broom.', exits: [{ direction: 'north', to: BAR, return_direction: 'south' }] }] };
    const { c, server, dir } = boot({ time: '09:00' });
    c.chat[0].extra.worldscrawl_patches = [NOOK_PATCH];
    await ext.refreshLivePlaces();
    const outline = outlineOf(server, { nook: true });
    // Chat mode.
    const cp = chatPanel({ c, server, outline, picks: [[NOOK]] });
    await cp.panel.refresh(); cp.panel.selectId('hesk', 'resolved'); click(cp.panel.el.querySelectorAll('.cast-edit')[0]);
    const idx = rowsOf(cp.panel).findIndex(r => r.querySelectorAll('.cf-chip').some(ch => ch.querySelectorAll('.cf-chiplabel')[0].textContent.endsWith(` - ${RAT}`)));
    click(rowsOf(cp.panel)[idx].querySelectorAll('.cf-addplace')[0]); await flush(10);
    const chip = chipsIn(cp.panel, idx).at(-1);
    assert.equal(chip.getAttribute('data-kind'), 'room');
    assert.equal(chipText(chip), `Storage Nook - ${NOOK}`);
    assert.doesNotMatch(chip.className, /\bbad\b/);
    assert.equal(warns(cp.panel), '', 'chat mode: no warning');
    assert.equal(errs(cp.panel), '');
    // Cast file mode: a warning, the file is written.
    const bp = await hesk(server, { outline, picks: [[NOOK]] });
    click(rowsOf(bp.panel)[MIGHT_ROW].querySelectorAll('.cf-addplace')[0]); await flush(10);
    assert.match(warns(bp.panel), /Storage Nook only exists in this chat: save it to the world first/);
    assert.equal(errs(bp.panel), '');
    assert.equal(bp.panel.el.querySelectorAll('.cast-save')[0].disabled, false);
    await confirmSave(bp.panel);
    assert.deepEqual(savedAsNew(dir).schedule[MIGHT_ROW].might, [RAT, NOOK]);
    // An Is-at place on that room in cast file mode is refused (the answer to "Base mode only", pinned).
    const ip = await hesk(server, { outline, picks: [NOOK] });
    click(rowsOf(ip.panel)[0].querySelectorAll('.wspick-choose')[0]); await flush(10);
    assert.match(errs(ip.panel), new RegExp(`${NOOK} is not in this world`));
    assert.equal(ip.panel.el.querySelectorAll('.cast-save')[0].disabled, true);
    c.chat[0].extra.worldscrawl_patches = [];
    await ext.refreshLivePlaces();
});

// ---- 7. the Remember card path (no code change to it)
const isRemember = p => /Remember this person/.test(p);
const isPick = p => /^Choose a daily pattern for /.test(p);
const MAREN = { name: 'Maren', personality: { summary: 'A knife-grinder who works for Hesk.', manner: 'Brisk.', speech: 'Clipped.' }, appearance: { summary: 'wiry woman with a whetstone' }, facts: [], invented: [] };
const SMITH_PICK = { pattern: 'day shift', job: SMITHY, job_activity: 'working the forge', home: null, favorites: [] };
const reply = (c, text, extra = {}) => { const m = { is_user: false, mes: text, swipe_id: 0, swipes: [text], swipe_info: [{ extra: {} }], extra }; c.chat.push(m); return m; };
const btn = (root, t) => root.querySelectorAll('.worldscrawl_card_btn').find(b => b.textContent === t);
test('Remember with an area job -> Approve -> the chat editor shows the work blocks as might rows with one area chip (wandering, importance high), saving them unchanged says Nothing changed; the card\'s Edit still has its four boxes', async () => {
    const SP = await import('../../extension/schedulepick.mjs');
    SP.scheduleErrors.clear(); SP.scheduleWarnings.clear();
    const { c, server } = boot({ time: '10:00', here: FORGE });
    c.generateRaw = async args => { const p = String(args?.prompt ?? ''); return isRemember(p) ? JSON.stringify(MAREN) : isPick(p) ? JSON.stringify(SMITH_PICK) : '{"place": null, "people": [], "wait": null}'; };
    reply(c, 'Maren, the knife-grinder, works the wheel by the fire.');
    await scene.offerRemember(c.chat[1], 'Maren');
    globalThis.document = makeDoc([0, 1]); renderPatchCards(); await flush(80);
    let doc = makeDoc([0, 1]); globalThis.document = doc; renderPatchCards();
    const card = () => doc.querySelector('.worldscrawl_remembercard');
    btn(card(), 'Edit').click(); await flush(10);
    assert.deepEqual(['sched_pattern', 'sched_job', 'sched_home', 'sched_favorites'].filter(k => card().querySelector(`.worldscrawl_${k}`)), ['sched_pattern', 'sched_job', 'sched_home', 'sched_favorites'], 'the card Edit keeps its four plain boxes');
    assert.equal(card().querySelectorAll('.cf-sched').length, 0, 'and no entry rows');
    btn(card(), 'Close editor').click(); await flush(10);
    doc = makeDoc([0, 1]); globalThis.document = doc; renderPatchCards();
    btn(card(), 'Approve').click(); await flush(80);
    const id = stampsOf(c.chat[1], 'npc_create')[0].id;
    const sch = stampsOf(c.chat[1], 'npc_schedule')[0];
    assert.equal(sch.pick.job_area, true);
    const p = chatPanel({ c, server, outline: outlineOf(server) });
    // The panel's chat form for the new person.
    c.chat[1].extra.worldscrawl_location = FORGE;
    await p.panel.refresh();
    p.panel.selectId(id, 'resolved');
    click(p.panel.el.querySelectorAll('.cast-edit')[0]);
    const work = rowsOf(p.panel).filter(r => r.className.includes('cf-might') && r.querySelectorAll('.cf-importance')[0].value === 'high');
    assert.equal(work.length, 2, 'two work blocks');
    for (const r of work) {
        assert.equal(r.querySelectorAll('.cf-chip').length, 1);
        assert.equal(r.querySelectorAll('.cf-chip')[0].getAttribute('data-kind'), 'area');
        assert.match(r.querySelectorAll('.cf-chiplabel')[0].textContent, new RegExp(` - ${SMITHY}$`));
        assert.equal(r.querySelectorAll('.cf-wandering')[0].checked, true);
    }
    click(p.panel.el.querySelectorAll('.cast-save')[0]);
    assert.match(p.panel.el.querySelector('.cast-review').textContent, /Nothing changed\./);
});
