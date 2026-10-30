// NPC phase 1.5: the map's cast browser / editor (pure helpers), the stateless save / delete routes, and the in-play view.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { NPC_KEY, npcPlayState } from '../../plugin/npc.mjs';
import { deleteCastNpc, loadCast, saveCastNpc } from '../../plugin/cast.mjs';
import { castRows, filterRows, formFromRecord, formProblems, markersAt, markersByPlace, recordFromForm, slugFor, stampRows, playSummary, within } from '../../plugin/ui/castdata.mjs';
import { client, copytree, RIVERTON, tmpPath } from './helpers.mjs';

const BAR = 'riverton:drowned_rat/common_room';
const UP = 'riverton:drowned_rat/upstairs';
const SQUARE = 'riverton:streets/square';
const temp = () => { const d = tmpPath(); copytree(RIVERTON, d); return d; };
const heskOf = dir => JSON.parse(fs.readFileSync(path.join(dir, 'cast', 'hesk.json'), 'utf8'));

test('castdata: rows, search and filters by place, status and disposition', () => {
    const cast = client(RIVERTON).get('/cast').json();
    const play = [{ id: 'maren', name: 'Maren', line: 'A knife-grinder.', position: { place: SQUARE }, disposition: { player: { value: 'friendly' } } }];
    const broken = { ok: true, id: 'bad', name: 'Bad', line: 'x', file: 'bad.json', schedule: [{ place: 'riverton:nowhere', broken: true }] };
    const rows = castRows([...cast.npcs, broken], play);
    assert.deepEqual(rows.map(r => [r.id, r.status]), [['bad', 'broken'], ['hesk', 'cast'], ['maren', 'play']]);
    assert.equal(filterRows(rows, { q: 'landlady' }).map(r => r.id).join(), 'hesk');
    assert.equal(filterRows(rows, { place: 'riverton:drowned_rat' }).map(r => r.id).join(), 'hesk');
    assert.equal(filterRows(rows, { place: SQUARE }).map(r => r.id).join(), 'maren');
    assert.equal(filterRows(rows, { status: 'broken' }).map(r => r.id).join(), 'bad');
    assert.equal(filterRows(rows, { disposition: 'indifferent' }).map(r => r.id).join(), 'hesk');
    assert.ok(within(BAR, 'riverton'));
    assert.ok(!within('riverton2:x', 'riverton'));
    const marks = markersByPlace(rows);
    assert.deepEqual(marks.get(BAR).map(m => m.id), ['hesk']);
    assert.equal(marks.get(SQUARE)[0].now, true);
    assert.deepEqual(markersAt(marks, { id: BAR }).map(m => m.id), ['hesk']);
    assert.deepEqual(markersAt(marks, { id: 'a', layer: { level: 'subregion', region: 'riverton', subregion: 'drowned_rat' } }).map(m => m.id), ['hesk']);
});

test('castdata: the form round-trips a record and validates inline', () => {
    const hesk = heskOf(RIVERTON);
    const f = formFromRecord({ raw: hesk });
    assert.deepEqual(recordFromForm(f), hesk);
    const places = new Set([BAR, UP, SQUARE]);
    assert.deepEqual(formProblems(f, { places, ids: new Set() }), {});
    assert.ok(formProblems(f, { places, ids: new Set(['hesk']) }).id, 'a new person cannot take a used id');
    assert.equal(slugFor('Old Tom', new Set(['old-tom'])), 'old-tom-2');
    const bad = { ...f, id: 'Bad Id', name: '', schedule: [{ ...f.schedule[0], place: 'riverton:nowhere', from: '25:00' }] };
    const p = formProblems(bad, { places, ids: new Set() });
    assert.ok(p.id && p.name && p['schedule.0.place'] && p['schedule.0.from']);
});

test('save and delete routes: create, rename, validate, duplicate id, delete', () => {
    const dir = temp();
    const c = client(dir);
    const made = c.post('/cast/save', { json: { npc: { id: 'old-tom', name: 'Old Tom', personality: { summary: 'A stooped farmer.' }, schedule: [{ place: SQUARE, activity: 'selling turnips', from: '08:00', to: '12:00', importance: 'normal' }] } } });
    assert.equal(made.status_code, 200, JSON.stringify(made.json()));
    assert.equal(made.json().id, 'old-tom');
    assert.ok(fs.existsSync(path.join(dir, 'cast', 'old-tom.json')));
    assert.ok(c.get('/cast').json().npcs.some(n => n.id === 'old-tom'));
    // the same id again, without saying it is the same person, is refused
    assert.equal(c.post('/cast/save', { json: { npc: { id: 'hesk', name: 'Other', personality: { summary: 'x' } } } }).status_code, 422);
    // a broken place is refused, and the file is untouched
    const before = fs.readFileSync(path.join(dir, 'cast', 'hesk.json'), 'utf8');
    assert.equal(c.post('/cast/save', { json: { npc: { ...heskOf(dir), schedule: [{ place: 'riverton:nowhere', activity: 'lost' }] }, original: 'hesk' } }).status_code, 422);
    assert.equal(fs.readFileSync(path.join(dir, 'cast', 'hesk.json'), 'utf8'), before);
    assert.equal(c.post('/cast/save', { json: { npc: { id: 'Not A Slug', name: 'X', personality: { summary: 'y' } } } }).status_code, 422);
    // edit in place
    const edited = c.post('/cast/save', { json: { npc: { ...heskOf(dir), facts: ['keeps a cudgel'] }, original: 'hesk', original_file: 'hesk.json' } });
    assert.equal(edited.status_code, 200);
    assert.deepEqual(heskOf(dir).facts, ['keeps a cudgel']);
    // rename moves the file
    const moved = c.post('/cast/save', { json: { npc: { id: 'tom', name: 'Old Tom', personality: { summary: 'A stooped farmer.' } }, original: 'old-tom', original_file: 'old-tom.json' } });
    assert.equal(moved.status_code, 200);
    assert.ok(fs.existsSync(path.join(dir, 'cast', 'tom.json')));
    assert.ok(!fs.existsSync(path.join(dir, 'cast', 'old-tom.json')));
    // delete
    assert.equal(c.post('/cast/delete', { json: { id: 'tom' } }).status_code, 200);
    assert.ok(!fs.existsSync(path.join(dir, 'cast', 'tom.json')));
    assert.equal(c.post('/cast/delete', { json: { id: 'tom' } }).status_code, 404);
    assert.equal(c.post('/cast/delete', { json: { file: '../world.json' } }).status_code, 404);
    assert.ok(!c.get('/cast').json().npcs.some(n => n.id === 'tom'));
});

test('saveCastNpc / deleteCastNpc directly, and empty fields are dropped', () => {
    const dir = temp();
    const r = saveCastNpc(dir, { id: 'pip', name: 'Pip', personality: { summary: 'A boy.' }, facts: [], manner: '' }, { places: new Set([SQUARE]) });
    assert.equal(r.id, 'pip');
    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'cast', 'pip.json'), 'utf8'));
    assert.equal(onDisk.facts, undefined);
    assert.equal(onDisk.manner, undefined);
    assert.ok(loadCast(dir).npcs.some(n => n.id === 'pip'));
    deleteCastNpc(dir, { id: 'pip' });
    assert.ok(!fs.existsSync(path.join(dir, 'cast', 'pip.json')));
});

test('npcPlayState: stamps with message numbers, and an exportable record', () => {
    const msg = (text, stamps, extra = {}) => ({ mes: text, is_user: false, extra: { [NPC_KEY]: stamps }, ...extra });
    const chat = [
        msg('Maren arrives.', [{ type: 'npc_create', id: 'maren', name: 'Maren', line: 'A knife-grinder.' }]),
        msg('She mentions her cart.', [{ type: 'npc_fact', id: 'maren', field: 'fact', text: 'Her cart squeaks.' }]),
    ];
    const play = npcPlayState(chat, [], {});
    const m = play.find(n => n.id === 'maren');
    assert.ok(m);
    assert.deepEqual(m.stamps.map(s => [s.msg, s.type]), [[0, 'npc_create'], [1, 'npc_fact']]);
    assert.deepEqual(m.record.facts, ['Her cart squeaks.']);
    assert.equal(stampRows(m).length, 2);
    assert.ok(typeof playSummary(m) === 'object' || typeof playSummary(m) === 'string');
    assert.deepEqual(npcPlayState([], [], {}), []);
});

import { npcWhy, whoAt, narratorView, unsavedPeople, framesOf } from '../../plugin/npc.mjs';
import { recordChanges, chatStamps, formFromPlay, whyRows, chatStampLines } from '../../plugin/ui/castdata.mjs';

const inspEnv = (hour, at = BAR) => ({
    exists: a => [BAR, UP, SQUARE, 'riverton:drowned_rat/courtyard'].includes(a), relocate: {},
    clock: () => ({ day: 3, hour, minute: 0, minutes: hour * 60 }), playerAt: () => at, actorAt: () => at, names: a => a.split('/').pop(),
});

test('inspector: why someone is where they are, who is at a place, the narrator view and unsaved people', () => {
    const cast = client(RIVERTON).get('/cast').json().npcs;
    const chat = [{ mes: 'You walk into the Drowned Rat.', is_user: true, extra: {} }, { mes: 'Hesk wipes the bar. A man called Bram Tull nods. Bram Tull drinks.', is_user: false, extra: { worldscrawl_npc_flags: [{ swipe: 0, names: ['Bram Tull'] }] } },
        { mes: 'Hello Hesk', is_user: true, extra: {} }, { mes: 'Bram Tull leaves. Hesk shrugs.', is_user: false, extra: { worldscrawl_npc_flags: [{ swipe: 0, names: ['Bram Tull', 'Hesk'] }] } }];
    const env = inspEnv(18); // 16:00–02:00 she is at the bar; the rest of the day she is off the map
    const hesk = framesOf(chat, 3, cast)[3].get('hesk');
    const w = npcWhy(hesk, 3, env);
    assert.equal(w.clock.day, 3);
    assert.ok(['stub', 'full'].includes(w.tier));
    assert.equal(w.from, 'cast');
    assert.ok(w.schedule && w.schedule.entry >= 0, JSON.stringify(w.schedule));
    assert.ok(w.reason.length > 0);
    assert.ok(whyRows({ why: w, position: {} }).some(([k]) => k === 'Why'));
    const here = whoAt(chat, 3, cast, env, w.schedule.address);
    assert.ok(here.some(x => x.id === 'hesk' && x.here));
    const elsewhere = whoAt(chat, 3, cast, env, SQUARE);
    assert.ok(!elsewhere.some(x => x.id === 'hesk' && x.here));
    const v = narratorView(chat, 3, cast, env);
    assert.equal(v.reply, 3);
    assert.equal(typeof v.npcs_present, 'string');
    assert.ok(Array.isArray(v.listed));
    assert.equal(narratorView(chat, 0, cast, env), null);
    const un = unsavedPeople(chat, { known: ['Hesk', 'hesk'], threshold: 3 });
    const bram = un.find(x => x.name.includes('Bram'));
    assert.ok(bram, JSON.stringify(un));
    assert.equal(bram.threshold, 3);
    assert.equal(bram.count, 2);
    assert.ok(!un.some(x => x.name === 'Hesk'));
});

test('sighting rolls: the seeded roll against the chance, and a no-show reason', () => {
    const npc = { ok: true, id: 'tam', name: 'Old Tam', line: 'A fisherman.', seen_at: { place: SQUARE, hour: 12, chance: 0.5 }, schedule: [] };
    const chat = [{ mes: 'hi', is_user: false, extra: {} }];
    const w = npcWhy(framesOf(chat, 0, [npc])[0].get('tam'), 0, inspEnv(12, SQUARE));
    assert.equal(w.sighting.active, true);
    assert.equal(w.sighting.now, 50);
    assert.ok(w.sighting.roll >= 0 && w.sighting.roll < 100);
    assert.equal(w.sighting.wouldShow, w.sighting.used < 50);
    const list = whoAt(chat, 0, [npc], inspEnv(12, SQUARE), SQUARE);
    const t = list.find(x => x.id === 'tam');
    assert.ok(t);
    if (!t.here) assert.match(t.reason, /No-show today: rolled \d+/);
});

test('editor diffs: base record changes and "In this chat" stamps', () => {
    assert.deepEqual(recordChanges({ id: 'a', line: 'x' }, { id: 'a', line: 'y', manner: 'calm' }).map(x => x.field), ['line', 'manner']);
    const play = { record: { id: 'm', name: 'M', personality: { summary: 'old' }, facts: ['f1'], memory: ['m1'] }, disposition: { player: { value: 'indifferent' } } };
    const f = formFromPlay(play);
    f.line = 'new'; f.facts = ['f1', 'f2']; f.memory = []; f.disposition = 'friendly'; f.reason = 'saved her cat';
    const { stamps, cannot } = chatStamps(play, f);
    assert.deepEqual(stamps.map(s => s.type), ['npc_fact', 'npc_fact', 'npc_disposition']);
    assert.equal(stamps[2].dramatic, true);
    assert.ok(cannot.some(x => x.includes('m1')));
    assert.equal(chatStampLines(stamps)[0], 'personality.summary: new');
    assert.deepEqual(chatStamps(play, formFromPlay(play)).stamps, []);
});

import { messageActivity, registerActivity } from '../../extension/activity.mjs';
import { addCallNote } from '../../extension/calllog.mjs';
import { groupEntries, registerRenderer, renderEntry } from '../../plugin/ui/activitylog.mjs';

test('activity log: entries from message data, session calls, and plug-in kinds', () => {
    const msg = { mes: 'x', extra: { worldscrawl_flag: { kind: 'discover', hint: 'cellar', source: 'tool' }, worldscrawl_npc: [{ type: 'npc_fact', id: 'hesk', text: 'hates rats' }],
        worldscrawl_wait: { label: '1h', seconds: 3600 }, worldscrawl_remember: { name: 'Bram', status: 'review' }, worldscrawl_enabled: true, worldscrawl_newthing: { a: 1 } } };
    addCallNote(msg, { kind: 'ws_flag discover', status: 'skipped', reason: 'dig failed' });
    const e = messageActivity(msg, 4, { extra: [{ kind: 'roll', label: 'Tam sighting', roll: 71, chance: 40, present: false }] });
    const kinds = e.map(x => x.kind);
    for (const k of ['flag', 'npc', 'clock', 'card', 'roll', 'call', 'worldscrawl_newthing']) assert.ok(kinds.includes(k), k);
    assert.ok(!kinds.includes('worldscrawl_enabled'));
    assert.equal(e.find(x => x.kind === 'flag').label, 'ws_flag discover');
    registerActivity('worldscrawl_lore', v => ({ kind: 'lore', label: 'lore request', text: v.topic }));
    assert.equal(messageActivity({ extra: { worldscrawl_lore: { topic: 'the flood' } } }, 0).find(x => x.kind === 'lore').text, 'the flood');
    const groups = groupEntries(e);
    assert.equal(groups[0].kind, 'flag');
    const $ = (tag, attrs, ...kids) => ({ tag, attrs, text: kids.flat().map(k => (typeof k === 'string' ? k : k?.text ?? '')).join('') });
    assert.match(renderEntry(e.find(x => x.kind === 'roll'), $).text, /rolled 71 vs 40% → no-show/);
    registerRenderer('lore', (x, h) => h('span', {}, `LORE ${x.text}`));
    assert.equal(renderEntry({ kind: 'lore', text: 'flood' }, $).text, 'LORE flood');
});
