import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    APPEARANCE_FIELDS, effectFields, effectSetKey, resolveAppearance, rebuildInputs,
    alreadyShown, alreadyEffect, junkAppearanceIntent, judgeAppearance, planAppearanceRebuild, acceptAppearanceRebuild, classifyAppearanceReply, looksInputKey, planLooksSummary, acceptLooksSummary,
    readAppearanceAnswer, sameAppearanceBase, NPC_KEY, framesOf, parseNpcTag, takeNpcTags,
    stampSummary, comingsAndGoings, npcAt, expiryOf,
} from '../../extension/npc.mjs';
import { validateRecord } from '../../plugin/npc.mjs';

const bot = (stamps = []) => ({ mes: 'x', is_user: false, swipe_id: 0, extra: stamps.length ? { [NPC_KEY]: stamps.map(s => ({ swipe: 0, ...s })) } : {} });
const user = mes => ({ mes, is_user: true, extra: {} });
const clock = i => ({ elapsed: i * 3600, day: 1, hour: 8 + i, minute: 0, minutes: (8 + i) * 60 });
const envClock = {
    clock,
    timeAt: s => ({ day: 1, hour: 8 + Math.floor(s / 3600), minute: Math.floor(s / 60) % 60 }),
    names: new Map(),
    index: new Map(),
};
const MAREN = { type: 'npc_create', id: 'maren', name: 'Maren', line: 'a grinder', looks: 'dark braids', body: 'stocky', outfit: 'leather apron' };
const BAR = 'riverton:drowned_rat/common_room';
const places = new Set([BAR]);
const heskRec = validateRecord({
    id: 'hesk', name: 'Hesk', line: 'The landlady.',
    looks: 'copper braids', body: 'sturdy', outfit: 'wool dress',
    schedule: [{ place: BAR, activity: 'pouring drinks', from: '00:00', to: '23:59', importance: 'high' }],
}, { file: 'hesk.json', places });
const at = (h, m = 0) => ({ day: 1, hour: Math.floor(h) % 24, minute: m, minutes: (h * 60 + m) % 1440, elapsed: 86400 + h * 3600 + m * 60 });
const envOf = (where, clocks) => ({
    exists: a => places.has(a), relocate: {}, names: a => a,
    playerAt: i => (Array.isArray(where) ? where[i] : where),
    clock: i => clocks[i],
});

test('effectFields: omit, empty, unknown, or all → all three; aliases normalize', () => {
    assert.deepEqual(effectFields(null), APPEARANCE_FIELDS);
    assert.deepEqual(effectFields(''), APPEARANCE_FIELDS);
    assert.deepEqual(effectFields('all'), APPEARANCE_FIELDS);
    assert.deepEqual(effectFields('looks, body'), ['looks', 'body']);
    assert.deepEqual(effectFields('summary|wearing'), ['looks', 'outfit']);
    assert.deepEqual(effectFields(['appearance', 'outfit']), ['looks', 'outfit']);
    assert.deepEqual(effectFields('nope'), APPEARANCE_FIELDS);
});

test('effectSetKey: stable ordered key of intent+fields', () => {
    assert.equal(effectSetKey([{ intent: 'Blonde', fields: 'looks' }]), 'blonde|looks');
    assert.equal(
        effectSetKey([{ intent: 'blonde', fields: 'looks' }, { intent: 'Tall', fields: ['body'] }]),
        'blonde|looks||tall|body',
    );
});

test('resolveAppearance: no effects → base; reuse cache; non-overlap engine; overlap pending', () => {
    const base = { looks: 'copper braids', body: 'sturdy', outfit: 'wool' };
    assert.deepEqual(resolveAppearance(base, []).how, 'base');
    assert.equal(resolveAppearance(base, []).looks, 'copper braids');

    const blonde = { intent: 'blonde hair', fields: ['looks'], text: { looks: 'blonde braids' } };
    const tall = { intent: 'tall', fields: ['body'], text: { body: 'towering' } };
    const eng = resolveAppearance(base, [blonde, tall], {});
    assert.equal(eng.how, 'engine');
    assert.equal(eng.looks, '', 'body changed, so the old summary is not current');
    assert.equal(eng.looksHow, 'pending');
    assert.equal(eng.body, 'towering');
    assert.equal(eng.outfit, 'wool');

    const key = effectSetKey([blonde, tall]);
    const lk = looksInputKey('cached B', 'cached O');
    const reuse = resolveAppearance(base, [blonde, tall], {
        [key]: { body: 'cached B', outfit: 'cached O' },
        [lk]: { looks: 'cached L', body: 'cached B', outfit: 'cached O' },
    });
    assert.equal(reuse.how, 'reuse');
    assert.equal(reuse.looks, 'cached L');
    assert.equal(reuse.looksHow, 'reuse');

    const gnoll = { intent: 'gnoll', fields: ['looks', 'body'] };
    const hybrid = { intent: 'half-horse', fields: ['body', 'outfit'] };
    const pend = resolveAppearance(base, [gnoll, hybrid], {});
    assert.equal(pend.how, 'pending');
    assert.ok(pend.needsModel);
    assert.deepEqual(pend.modelFields, ['body']); // looks has one, body overlaps, outfit has one — only body overlaps >1
});

test('resolveAppearance: missing rewritten text on a field → pending for that field', () => {
    const base = { looks: 'a', body: 'b', outfit: 'c' };
    const e = { intent: 'blonde', fields: ['looks'] }; // looks is not a body/outfit rewrite
    const r = resolveAppearance(base, [e], {});
    assert.equal(r.needsModel, false);
    assert.equal(r.looks, 'a');
    const body = { intent: 'burned', fields: ['body'] };
    const missing = resolveAppearance(base, [body], {});
    assert.equal(missing.how, 'pending');
    assert.deepEqual(missing.modelFields, ['body']);
});

test('rebuildInputs: base fields + still-active intents in start order; never prior combined text', () => {
    const base = { looks: 'copper', body: 'sturdy', outfit: 'wool' };
    const effects = [
        { intent: 'gnoll form', fields: ['looks', 'body'] },
        { intent: 'half-horse', fields: ['body', 'outfit'] },
    ];
    const r = rebuildInputs(base, effects, ['body']);
    assert.deepEqual(r.fields, ['body']);
    assert.equal(r.base.body, 'sturdy');
    assert.deepEqual(r.intents, [
        { intent: 'gnoll form', fields: ['body'] },
        { intent: 'half-horse', fields: ['body'] },
    ]);
});

test('alreadyShown / alreadyEffect: Known, Looks, active intent, temps', () => {
    const npc = {
        facts: ['owes Hesk'], looks: 'blonde braids', body: '', outfit: '',
        effects: [{ intent: 'blonde hair', fields: ['looks'] }],
        temps: [{ text: 'wet sleeves' }],
    };
    assert.equal(alreadyShown(npc, 'owes Hesk'), true);
    assert.equal(alreadyShown(npc, 'blonde braids'), true);
    assert.equal(alreadyShown(npc, 'blonde hair'), true);
    assert.equal(alreadyShown(npc, 'wet sleeves'), true);
    assert.equal(alreadyShown(npc, 'something new'), false);
    assert.equal(alreadyEffect(npc, 'blonde hair', 'looks'), true);
    assert.equal(alreadyEffect(npc, 'blonde hair', 'body'), false);
    assert.equal(alreadyEffect(npc, 'tall', 'body'), false);
});

test('no-op appearance is rejected; a real change still applies; an already-active effect still skips', () => {
    const hesk = { id: 'hesk', name: 'Hesk', looks: 'copper braids', body: 'sturdy', outfit: 'wool dress', effects: [] };
    for (const intent of ['', 'looks', 'Looks.', 'APPEARED', 'she appeared', 'her looks']) {
        assert.equal(junkAppearanceIntent(intent), true, intent);
        assert.equal(judgeAppearance(hesk, { type: 'npc_appearance', id: 'hesk', intent }), 'reject', intent);
    }
    assert.equal(judgeAppearance(hesk, { type: 'npc_appearance', id: 'hesk', intent: 'appeared', fields: 'outfit' }), 'reject');
    assert.equal(judgeAppearance(hesk, { type: 'npc_appearance', id: 'hesk', intent: 'looks', outfit: 'wool dress' }), 'reject');
    assert.equal(judgeAppearance(hesk, { type: 'npc_appearance', id: 'hesk', intent: 'looks', outfit: 'a soaked cloak' }), 'apply');
    assert.equal(judgeAppearance(hesk, { type: 'npc_appearance', id: 'hesk', intent: '', outfit: 'a soaked cloak' }), 'apply');
    assert.equal(judgeAppearance(hesk, { type: 'npc_appearance', id: 'hesk', intent: 'soaked from the rain', fields: 'outfit' }), 'apply');
    assert.equal(judgeAppearance(hesk, { type: 'npc_appearance', id: 'hesk', intent: 'walks in soaked', fields: 'outfit' }), 'apply');
    const active = { ...hesk, effects: [{ intent: 'blonde hair', fields: ['looks'] }] };
    assert.equal(judgeAppearance(active, { type: 'npc_appearance', id: 'hesk', intent: 'blonde hair', fields: 'looks' }), 'skip');
    assert.equal(judgeAppearance(active, { type: 'npc_appearance', id: 'hesk', intent: 'soaked from the rain', fields: 'outfit' }), 'apply');
});

test('parseNpcTag / takeNpcTags: appearance with fields and lasts', () => {
    assert.deepEqual(parseNpcTag('appearance | maren | blonde hair | looks | 2 hours'), {
        type: 'npc_appearance', id: 'maren', intent: 'blonde hair', fields: 'looks', lasts: 120,
    });
    assert.deepEqual(parseNpcTag('appearance | maren | polymorphed into a gnoll'), {
        type: 'npc_appearance', id: 'maren', intent: 'polymorphed into a gnoll',
    });
    assert.deepEqual(parseNpcTag('appearance | hesk'), { type: 'npc_appearance', id: 'hesk', intent: '' });
    const { stamps, text } = takeNpcTags('Poof. [ws_npc: appearance | maren | tall | body | 1 hour]');
    assert.equal(stamps.length, 1);
    assert.equal(stamps[0].intent, 'tall');
    assert.equal(stamps[0].lasts, 60);
    assert.ok(!/ws_npc/.test(text));
});

test('stampSummary: appearance shows intent and lasts, and a cache is not a row', () => {
    assert.match(stampSummary({ type: 'npc_appearance', id: 'maren', intent: 'blonde', fields: 'body', lasts: 60 }, 'Maren'), /Maren: appearance — blonde \(for 1h\)/);
    assert.match(stampSummary({ type: 'npc_appearance', id: 'maren', intent: 'gnoll' }, 'Maren'), /appearance — gnoll/);
    assert.equal(stampSummary({ type: 'npc_appearance_cache', how: 'engine' }, 'Maren'), '');
});

function committedAppearance({ id, intent, fields = 'body', layer = {}, lasts = null, start = 0 }) {
    const owner = `o_${id}_${intent}`;
    return {
        type: 'npc_appearance', id, intent, owner, swipe: 0, start, lasts,
        identity: { owner, message: 'm', swipe: 0, npc: id, domain: 'appearance', chat: 'c' },
        decisionRev: 1, off: false, contentId: `c_${id}_${intent}`,
        committed: { kind: 'appearance', intent, fields, layer }, candidate: null,
    };
}

test('framesOf: a temporary body applies and expires back to the pinned baseline', () => {
    const chat = [
        bot([MAREN, committedAppearance({ id: 'maren', intent: 'taller', fields: 'body', layer: { body: 'a taller frame' }, lasts: 120 })]),
        bot(), bot(), bot(),
    ];
    const f0 = framesOf(chat, 0, [], clock).at(-1).get('maren');
    assert.equal(f0.body, 'a taller frame');
    assert.equal(f0.pinned.body, 'stocky');
    assert.equal(f0.looks, '', 'the body changed, so the old summary is not current');
    assert.equal(framesOf(chat, 2, [], clock).at(-1).get('maren').body, 'stocky', 'over after two game hours');
    assert.equal(framesOf(chat, 2, [], clock).at(-1).get('maren').looks, 'dark braids');
    const waiting = [bot([MAREN, { ...committedAppearance({ id: 'maren', intent: 'scar' }), committed: null, candidate: { phase: 'working' } }])];
    assert.equal(framesOf(waiting, 0, [], clock).at(-1).get('maren').body, 'stocky', 'an unapproved owner is not in the replay');
});

test('framesOf: stacked temps; earlier expiry leaves the later body on the pinned baseline', () => {
    const chat = [
        bot([MAREN,
            committedAppearance({ id: 'maren', intent: 'outfit', fields: 'outfit', layer: { outfit: 'a bright dress' }, lasts: 60 }),
            committedAppearance({ id: 'maren', intent: 'tall', fields: 'body', layer: { body: 'towering' }, lasts: 120 }),
        ]),
        bot(), bot(),
    ];
    const mid = framesOf(chat, 1, [], clock).at(-1).get('maren');
    assert.equal(mid.body, 'towering');
    assert.equal(mid.outfit, 'leather apron');
    assert.equal(mid.looksHow, 'pending');
    const end = framesOf(chat, 2, [], clock).at(-1).get('maren');
    assert.equal(end.body, 'stocky');
    assert.equal(end.looks, 'dark braids');
});

test('framesOf: a Looks fact does not author the summary', () => {
    const chat = [bot([MAREN, { type: 'npc_fact', id: 'maren', field: 'appearance.summary', text: 'silver hair' }])];
    const n = framesOf(chat, 0, []).at(-1).get('maren');
    assert.equal(n.looks, 'dark braids');
    assert.equal(n.base.looks, 'dark braids');
});

test('comings: expired appearance while still in scene goes on the comings line', () => {
    // Hesk always here. Stamp a 30m blonde at first reply; second reply is +1h later so it expired.
    const chat = [
        bot([committedAppearance({ id: 'hesk', intent: 'blonde hair', fields: 'body', layer: { body: 'blonde braids' }, lasts: 30, start: 86400 + 16 * 3600 })]),
        user('I wait an hour.'),
        bot(),
    ];
    const clocks = [at(16), at(16), at(17)];
    const lines = comingsAndGoings(chat, 2, [heskRec], envOf(BAR, clocks));
    assert.ok(lines.some(l => /^\[\d\d:\d\d\] Hesk's blonde hair fades\.$/.test(l)), lines);
});

test('npcAt / expiryOf: a committed body is live, and stored start expires', () => {
    const chat = [bot([MAREN, committedAppearance({ id: 'maren', intent: 'blonde', fields: 'body', layer: { body: 'taller' }, lasts: 60 })]), bot()];
    const n = npcAt(chat, 0, [], 'maren', clock);
    assert.equal(n.body, 'taller');
    assert.equal(n.pinned.body, 'stocky');
    const s = { type: 'npc_appearance', id: 'maren', intent: 'blonde', lasts: 60, start: 0 };
    assert.equal(expiryOf(s, 0, 0, envClock).over, false);
    assert.equal(expiryOf(s, 0, 1, envClock).over, true);
});


test('plan/acceptAppearanceRebuild: needs model, covers fields, stale base/key, failed answer', () => {
    const base = { looks: 'copper braids', body: 'sturdy', outfit: 'wool' };
    const e = { intent: 'magically young', fields: ['body'] };
    const npc = { id: 'hesk', name: 'Hesk', base, effects: [e], caches: {} };
    const plan = planAppearanceRebuild(npc);
    assert.ok(plan);
    assert.equal(plan.key, 'magically young|body');
    assert.deepEqual(plan.fields, ['body']);
    assert.equal(plan.inputs.intents[0].intent, 'magically young');
    assert.equal(planAppearanceRebuild({ ...npc, effects: [{ ...e, text: { body: 'young' } }] }), null);

    assert.deepEqual(acceptAppearanceRebuild(plan, { looks: 'only looks' }, npc), { failed: true });
    const ok = acceptAppearanceRebuild(plan, { looks: 'young copper braids', body: 'a young sturdy woman' }, npc);
    assert.equal(ok.record?.kind, 'fields');
    assert.equal(ok.record.body, 'a young sturdy woman');
    assert.equal(ok.record.key, plan.key);
    assert.equal(ok.stamp, undefined);

    assert.deepEqual(acceptAppearanceRebuild(plan, { looks: 'x', body: 'x' }, { ...npc, base: { ...base, looks: 'changed' } }), { stale: true });
    assert.deepEqual(acceptAppearanceRebuild(plan, { looks: 'only looks' }, npc), { failed: true });
    assert.deepEqual(acceptAppearanceRebuild(plan, null, npc), { failed: true });
    assert.equal(readAppearanceAnswer({ body: '  young  ', looks: '' }).body, 'young');
    assert.equal(sameAppearanceBase(base, { looks: 'copper braids', body: 'sturdy', outfit: 'wool' }), true);
});

test('full path: appearance tag → mocked rewrite → cache + Looks → expiry restores base', () => {
    // Tag (no rewritten body text) → needsModel → accept mocked rewrite → Looks change → +1h restores base.
    const tag = committedAppearance({ id: 'hesk', intent: 'magically young', fields: 'body', layer: {}, lasts: 60 });
    const chat = [
        bot([{ type: 'npc_create', id: 'hesk', name: 'Hesk', line: 'landlady', looks: 'copper braids', body: 'sturdy', outfit: 'wool' }, tag]),
    ];
    const before = framesOf(chat, 0, [], clock).at(-1).get('hesk');
    assert.equal(before.appearanceHow, 'pending');
    assert.equal(before.body, '');
    chat[0].extra.worldscrawl_compose = { swipe: 0, records: [{ kind: 'fields', key: before.appearanceKey, inputsKey: before.appearanceKey, npc: 'hesk', body: 'a magically young, sturdy woman', outfit: 'wool' }] };
    const after = framesOf(chat, 0, [], clock).at(-1).get('hesk');
    assert.equal(after.body, 'a magically young, sturdy woman');
    assert.equal(after.looks, '');
    assert.equal(after.looksHow, 'pending');
    assert.equal(after.pinned.body, 'sturdy');
    chat[0].extra.worldscrawl_compose.records.push({ kind: 'looks', key: after.looksKey, inputsKey: after.looksKey, npc: 'hesk', body: after.body, outfit: after.outfit, looks: 'young, copper braids' });
    assert.equal(framesOf(chat, 0, [], clock).at(-1).get('hesk').looks, 'young, copper braids');
    chat.push(bot());
    const expired = framesOf(chat, 1, [], clock).at(-1).get('hesk');
    assert.equal(expired.body, 'sturdy');
    assert.equal(expired.looks, 'copper braids');
    assert.equal(expired.appearanceHow, 'base');
});

test('full path via takeNpcTags: strip tag, stamp, rebuild, Looks change', () => {
    const reply = 'Hesk looks years younger. [ws_npc: appearance | hesk | magically young | body | 1 hour]';
    const { stamps, text } = takeNpcTags(reply);
    assert.equal(stamps.length, 1);
    assert.equal(stamps[0].type, 'npc_appearance');
    assert.ok(!/ws_npc/.test(text));

    const owned = committedAppearance({ id: 'hesk', intent: stamps[0].intent, fields: 'body', layer: { body: 'young Hesk' }, lasts: 60 });
    const chat = [bot([{ type: 'npc_create', id: 'hesk', name: 'Hesk', line: 'x', looks: 'copper braids', body: 'sturdy', outfit: 'wool' }, owned])];
    const got = framesOf(chat, 0, [], clock).at(-1).get('hesk');
    assert.equal(got.body, 'young Hesk');
    assert.equal(got.looks, '');
    chat[0].extra.worldscrawl_compose = { swipe: 0, records: [{ kind: 'looks', key: got.looksKey, inputsKey: got.looksKey, npc: 'hesk', body: got.body, outfit: got.outfit, looks: 'young Hesk, copper braids' }] };
    assert.equal(framesOf(chat, 0, [], clock).at(-1).get('hesk').looks, 'young Hesk, copper braids');
});

test('layered body effects: the combined text is not reused after one layer expires', () => {
    const gnoll = committedAppearance({ id: 'hesk', intent: 'gnoll', fields: 'body', layer: {}, lasts: 120 });
    const centaur = committedAppearance({ id: 'hesk', intent: 'centaur', fields: 'body', layer: {}, lasts: 60 });
    const chat = [bot([
        { type: 'npc_create', id: 'hesk', name: 'Hesk', line: 'x', looks: 'copper braids', body: 'sturdy', outfit: 'wool' },
        gnoll, centaur,
    ])];
    const both = framesOf(chat, 0, [], clock).at(-1).get('hesk');
    assert.equal(both.appearanceHow, 'pending');
    chat[0].extra.worldscrawl_compose = { swipe: 0, records: [{ kind: 'fields', key: both.appearanceKey, inputsKey: both.appearanceKey, npc: 'hesk', body: 'a gnoll-centaur frame', outfit: 'wool' }] };
    assert.equal(framesOf(chat, 0, [], clock).at(-1).get('hesk').body, 'a gnoll-centaur frame');
    chat.push(bot());
    const left = framesOf(chat, 1, [], clock).at(-1).get('hesk');
    assert.equal(left.liveOps.map(o => o.intent).join(','), 'gnoll');
    assert.equal(left.body, '', 'the combined text is not reused for the remaining layer');
    assert.equal(left.appearanceHow, 'pending');
});

test('classifyAppearanceReply: empty, refusal, truncated, partial and complete', () => {
    const fields = ['looks', 'body', 'outfit'];
    assert.equal(classifyAppearanceReply('', fields).kind, 'empty');
    assert.equal(classifyAppearanceReply('   ', fields).kind, 'empty');
    assert.equal(classifyAppearanceReply('I cannot rewrite that.', fields).kind, 'refusal');
    assert.equal(classifyAppearanceReply('{"looks": "a young', fields).kind, 'truncated');
    assert.equal(classifyAppearanceReply('nope', fields).kind, 'malformed');
    assert.equal(classifyAppearanceReply('{"body":"younger"}', fields).kind, 'partial');
    assert.equal(classifyAppearanceReply('{"looks":"","body":"young","outfit":"dress"}', fields).kind, 'partial');
    const ok = classifyAppearanceReply('{"looks":"young braids","body":"years younger","outfit":"a bright dress"}', fields);
    assert.equal(ok.kind, 'ok');
    assert.equal(ok.answer.outfit, 'a bright dress');
});
