import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    APPEARANCE_FIELDS, effectFields, effectSetKey, resolveAppearance, rebuildInputs,
    alreadyShown, alreadyEffect, junkAppearanceIntent, judgeAppearance, planAppearanceRebuild, acceptAppearanceRebuild,
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
    assert.equal(eng.looks, 'blonde braids');
    assert.equal(eng.body, 'towering');
    assert.equal(eng.outfit, 'wool');

    const key = effectSetKey([blonde, tall]);
    const reuse = resolveAppearance(base, [blonde, tall], { [key]: { looks: 'cached L', body: 'cached B', outfit: 'cached O' } });
    assert.equal(reuse.how, 'reuse');
    assert.equal(reuse.looks, 'cached L');

    const gnoll = { intent: 'gnoll', fields: ['looks', 'body'] };
    const hybrid = { intent: 'half-horse', fields: ['body', 'outfit'] };
    const pend = resolveAppearance(base, [gnoll, hybrid], {});
    assert.equal(pend.how, 'pending');
    assert.ok(pend.needsModel);
    assert.deepEqual(pend.modelFields, ['body']); // looks has one, body overlaps, outfit has one — only body overlaps >1
});

test('resolveAppearance: missing rewritten text on a field → pending for that field', () => {
    const base = { looks: 'a', body: 'b', outfit: 'c' };
    const e = { intent: 'blonde', fields: ['looks'] }; // no text
    const r = resolveAppearance(base, [e], {});
    assert.equal(r.how, 'pending');
    assert.deepEqual(r.modelFields, ['looks']);
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

test('stampSummary: appearance shows intent, fields, lasts, player', () => {
    assert.match(stampSummary({ type: 'npc_appearance', id: 'maren', intent: 'blonde', fields: 'looks', lasts: 60 }, 'Maren'), /Maren: appearance — blonde \[looks\] \(for 1h\)/);
    assert.match(stampSummary({ type: 'npc_appearance', id: 'maren', intent: 'gnoll', by: 'player' }, 'Maren'), /appearance — gnoll \(player\)/);
    assert.match(stampSummary({ type: 'npc_appearance_cache', how: 'engine' }, 'Maren'), /appearance rebuild \(engine\)/);
});

test('framesOf: temp appearance applies and expires; lasting pending waits then folds into base', () => {
    const chat = [
        bot([MAREN, { type: 'npc_appearance', id: 'maren', intent: 'blonde hair', fields: 'looks', lasts: 120, looks: 'blonde braids' }]),
        bot(),
        bot(),
        bot(),
    ];
    const f0 = framesOf(chat, 0, [], clock).at(-1).get('maren');
    assert.equal(f0.looks, 'blonde braids');
    assert.equal(f0.base.looks, 'dark braids');
    assert.equal(f0.effects.length, 1);
    assert.ok(['engine', 'reuse'].includes(f0.appearanceHow), f0.appearanceHow);
    assert.equal(framesOf(chat, 1, [], clock).at(-1).get('maren').effects.length, 1);
    assert.equal(framesOf(chat, 2, [], clock).at(-1).get('maren').effects.length, 0, 'over after two game hours');
    assert.equal(framesOf(chat, 2, [], clock).at(-1).get('maren').looks, 'dark braids');

    const lasting = [
        bot([MAREN, { type: 'npc_appearance', id: 'maren', intent: 'scar on cheek', fields: 'looks', looks: 'dark braids, scar on cheek', pending: true }]),
        bot(),
    ];
    assert.equal(framesOf(lasting, 1, [], clock).at(-1).get('maren').looks, 'dark braids', 'pending lasting not applied');
    delete lasting[0].extra[NPC_KEY][1].pending;
    const after = framesOf(lasting, 1, [], clock).at(-1).get('maren');
    assert.equal(after.looks, 'dark braids, scar on cheek');
    assert.equal(after.base.looks, 'dark braids, scar on cheek', 'lasting folded into chat-stamp base');
    assert.equal(after.effects.length, 0);
});

test('framesOf: stacked non-overlap temps; earlier expiry leaves the later one on the original base', () => {
    // Blonde 1h then tall 2h — after blonde expires, tall still on dark-braids base (not peeled to a blonde layer).
    const chat = [
        bot([MAREN,
            { type: 'npc_appearance', id: 'maren', intent: 'blonde', fields: 'looks', lasts: 60, looks: 'blonde braids' },
            { type: 'npc_appearance', id: 'maren', intent: 'tall', fields: 'body', lasts: 120, body: 'towering' },
        ]),
        bot(), // +1h: blonde gone, tall remains
        bot(), // +2h: tall gone
    ];
    const mid = framesOf(chat, 1, [], clock).at(-1).get('maren');
    assert.equal(mid.looks, 'dark braids', 'blonde expired; base looks restored');
    assert.equal(mid.body, 'towering');
    assert.equal(mid.effects.map(e => e.intent).join(','), 'tall');
    const end = framesOf(chat, 2, [], clock).at(-1).get('maren');
    assert.equal(end.looks, 'dark braids');
    assert.equal(end.body, 'stocky');
    assert.equal(end.effects.length, 0);
});

test('framesOf: CARD_FIELDS appearance write updates base so resolve does not wipe it', () => {
    const chat = [bot([MAREN, { type: 'npc_fact', id: 'maren', field: 'appearance.summary', text: 'silver hair' }])];
    const n = framesOf(chat, 0, []).at(-1).get('maren');
    assert.equal(n.looks, 'silver hair');
    assert.equal(n.base.looks, 'silver hair');
});

test('comings: expired appearance while still in scene goes on the comings line', () => {
    // Hesk always here. Stamp a 30m blonde at first reply; second reply is +1h later so it expired.
    const chat = [
        bot([{ type: 'npc_appearance', id: 'hesk', intent: 'blonde hair', fields: 'looks', lasts: 30, looks: 'blonde braids' }]),
        user('I wait an hour.'),
        bot(),
    ];
    const clocks = [at(16), at(16), at(17)];
    const lines = comingsAndGoings(chat, 2, [heskRec], envOf(BAR, clocks));
    assert.ok(lines.some(l => /Hesk's blonde hair fades \(expired/.test(l)), lines);
});

test('npcAt / expiryOf: appearance exposed with how and expiry', () => {
    const chat = [bot([MAREN, { type: 'npc_appearance', id: 'maren', intent: 'blonde', fields: 'looks', lasts: 60, looks: 'blonde' }]), bot()];
    const n = npcAt(chat, 0, [], 'maren');
    assert.ok(['engine', 'reuse'].includes(n.appearanceHow), n.appearanceHow);
    assert.equal(n.effects[0].intent, 'blonde');
    assert.equal(n.base.looks, 'dark braids');
    const s = { type: 'npc_appearance', id: 'maren', intent: 'blonde', lasts: 60 };
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
    assert.deepEqual(plan.fields, ['looks', 'body']); // Looks summarizes Body: rewritten with it
    assert.equal(plan.inputs.intents[0].intent, 'magically young');
    assert.equal(planAppearanceRebuild({ ...npc, effects: [{ ...e, text: { body: 'young' } }] }), null);

    assert.deepEqual(acceptAppearanceRebuild(plan, { body: 'no looks' }, npc), { failed: true });
    const ok = acceptAppearanceRebuild(plan, { looks: 'young copper braids', body: 'a young sturdy woman' }, npc);
    assert.equal(ok.stamp?.type, 'npc_appearance_cache');
    assert.equal(ok.stamp.body, 'a young sturdy woman');
    assert.equal(ok.stamp.key, plan.key);

    assert.deepEqual(acceptAppearanceRebuild(plan, { looks: 'x', body: 'x' }, { ...npc, base: { ...base, looks: 'changed' } }), { stale: true });
    assert.deepEqual(acceptAppearanceRebuild(plan, { looks: 'only looks' }, npc), { failed: true });
    assert.deepEqual(acceptAppearanceRebuild(plan, null, npc), { failed: true });
    assert.equal(readAppearanceAnswer({ body: '  young  ', looks: '' }).body, 'young');
    assert.equal(sameAppearanceBase(base, { looks: 'copper braids', body: 'sturdy', outfit: 'wool' }), true);
});

test('full path: appearance tag → mocked rewrite → cache + Looks → expiry restores base', () => {
    // Tag (no rewritten body text) → needsModel → accept mocked rewrite → Looks change → +1h restores base.
    const tag = parseNpcTag('appearance | hesk | magically young | body | 1 hour');
    assert.deepEqual(tag, { type: 'npc_appearance', id: 'hesk', intent: 'magically young', fields: 'body', lasts: 60 });

    const chat = [
        bot([{ type: 'npc_create', id: 'hesk', name: 'Hesk', line: 'landlady', looks: 'copper braids', body: 'sturdy', outfit: 'wool' }, tag]),
    ];
    const before = framesOf(chat, 0, [], clock).at(-1).get('hesk');
    assert.equal(before.appearanceHow, 'pending');
    assert.equal(before.body, 'sturdy'); // still base until cache
    const plan = planAppearanceRebuild(before);
    assert.ok(plan);
    assert.deepEqual(plan.fields, ['looks', 'body']);

    const accepted = acceptAppearanceRebuild(plan, { looks: 'young, copper braids', body: 'a magically young, sturdy woman' }, before);
    assert.ok(accepted.stamp);
    chat[0].extra[NPC_KEY].push({ swipe: 0, ...accepted.stamp });

    const after = framesOf(chat, 0, [], clock).at(-1).get('hesk');
    assert.equal(after.body, 'a magically young, sturdy woman');
    assert.ok(['reuse', 'model'].includes(after.appearanceHow) || after.caches[plan.key], after.appearanceHow);
    assert.equal(after.looks, 'young, copper braids');
    assert.equal(after.base.body, 'sturdy');
    // The public npc (what scene.mjs plans from) carries the cache, so no second rebuild is asked for.
    chat.push(bot());
    assert.equal(planAppearanceRebuild(npcAt(chat, 0, [], 'hesk')), null);
    chat.pop();

    // Advance game time past 1 hour: effect expires, base restored (no peel to a wrong layer).
    chat.push(bot());
    const expired = framesOf(chat, 1, [], clock).at(-1).get('hesk');
    assert.equal(expired.body, 'sturdy');
    assert.equal(expired.looks, 'copper braids');
    assert.equal(expired.effects.length, 0);
    assert.equal(expired.appearanceHow, 'base');
});

test('full path via takeNpcTags: strip tag, stamp, rebuild, Looks change', () => {
    const reply = 'Hesk looks years younger. [ws_npc: appearance | hesk | magically young | body | 1 hour]';
    const { stamps, text } = takeNpcTags(reply);
    assert.equal(stamps.length, 1);
    assert.equal(stamps[0].type, 'npc_appearance');
    assert.ok(!/ws_npc/.test(text));

    const chat = [bot([{ type: 'npc_create', id: 'hesk', name: 'Hesk', line: 'x', looks: 'copper braids', body: 'sturdy', outfit: 'wool' }, stamps[0]])];
    const n = framesOf(chat, 0, [], clock).at(-1).get('hesk');
    const plan = planAppearanceRebuild(n);
    const { stamp } = acceptAppearanceRebuild(plan, { looks: 'young Hesk, copper braids', body: 'young Hesk' }, n);
    chat[0].extra[NPC_KEY].push({ swipe: 0, ...stamp });
    const got = framesOf(chat, 0, [], clock).at(-1).get('hesk');
    assert.equal(got.body, 'young Hesk');
    assert.equal(got.looks, 'young Hesk, copper braids');
});
