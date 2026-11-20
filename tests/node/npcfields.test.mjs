import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NPC_KEY, framesOf, parseNpcTag, lastsMinutes, lastsText, expiryOf, npcPlayState } from '../../extension/npc.mjs';
import { findPerson } from '../../extension/names.mjs';
import { expiryText, stampRows } from '../../plugin/ui/castdata.mjs';

const bot = (stamps = []) => ({ mes: 'x', is_user: false, swipe_id: 0, extra: stamps.length ? { [NPC_KEY]: stamps.map(s => ({ swipe: 0, ...s })) } : {} });
const MAREN = { type: 'npc_create', id: 'maren', name: 'Maren', line: 'a grinder' };
// one game hour passes per message
const clock = i => ({ elapsed: i * 3600, day: 1, hour: 8 + i, minute: 0 });
const env = { clock, timeAt: s => ({ day: 1, hour: 8 + Math.floor(s / 3600), minute: Math.floor(s / 60) % 60 }), names: new Map(), index: new Map() };

test('lasts: reads numbers and game-time text, lasting otherwise', () => {
    assert.equal(lastsMinutes(90), 90);
    assert.equal(lastsMinutes('2 hours'), 120);
    assert.equal(lastsMinutes('for 30 min'), 30);
    assert.equal(lastsMinutes('1 day'), 1440);
    assert.equal(lastsMinutes('forever'), null);
    assert.equal(lastsMinutes(0), null);
    assert.equal(lastsText(90), '1h30m');
    assert.equal(lastsText(1500), '1d1h');
});

test('a fact tag with a trailing duration is dropped (a fact has no end); other trailing text is part of the fact', () => {
    assert.deepEqual(parseNpcTag('fact | maren | bandaged hand | 2 hours'), { dropped: 'a fact has no end', type: 'npc_fact', id: 'maren', text: 'bandaged hand', lasts: '2 hours' });
    assert.deepEqual(parseNpcTag('fact | maren | likes rain | hates snow'), { type: 'npc_fact', id: 'maren', field: 'fact', text: 'likes rain | hates snow' });
    assert.deepEqual(parseNpcTag('fact | maren | 2 hours'), { type: 'npc_fact', id: 'maren', field: 'fact', text: '2 hours' });
});

test('a pending fact waits for the card; once approved it holds with no end', () => {
    const chat = [bot([MAREN, { type: 'npc_fact', id: 'maren', field: 'fact', text: 'owes Hesk', pending: true }]), bot(), bot(), bot()];
    const f = framesOf(chat, 3, [], clock);
    assert.ok(!f[0].get('maren').facts.includes('owes Hesk'));
    assert.equal(f[0].get('maren').temps, undefined, 'there are no temporary facts');
    delete chat[0].extra[NPC_KEY][1].pending;
    assert.ok(framesOf(chat, 3, [], clock).every(fr => fr.get('maren').facts.includes('owes Hesk')), 'holds on every later frame');
    assert.ok(framesOf(chat, 3, [], clock).at(-1).get('maren').facts.includes('owes Hesk'), 'approved');
});

test('lasts: the inspector shows when each field change ends', () => {
    const s = { type: 'npc_appearance', id: 'maren', intent: 'bruised lip', lasts: 120 }; // facts have no end: only appearance changes expire
    assert.deepEqual(expiryOf({ ...s, lasts: undefined }, 0, 3, env), { lasting: true });
    assert.deepEqual(expiryOf(s, 0, 1, env), { lasts: 120, until: { day: 1, hour: 10, minute: 0 }, over: false });
    assert.equal(expiryOf(s, 0, 3, env).over, true);
    assert.equal(expiryText(expiryOf(s, 0, 1, env)), ' (until day 1 10:00)');
    assert.equal(expiryText(expiryOf(s, 0, 3, env)), ' (ended day 1 10:00)');
    assert.equal(expiryText({ lasting: true }), ' (lasting)');
    assert.equal(expiryText({ lasts: 30, until: null }), ' (for 30m)');
    assert.equal(expiryText(null), '');
    const rows = stampRows({ stamps: [{ msg: 0, type: 'npc_fact', summary: 'Maren: owes Hesk', pending: true, expiry: { lasting: true } }] });
    assert.equal(rows[0].text, 'Maren: owes Hesk (⏳ waiting on you) (lasting)');
});

test('npcPlayState: a fact stamp carries pending and no expiry, and its summary has no "(for …)"', () => {
    const chat = [bot([MAREN, { type: 'npc_fact', id: 'maren', field: 'fact', text: 'owes Hesk' }]), bot(), bot()];
    const fact = npcPlayState(chat, [], env).find(p => p.id === 'maren').stamps.find(x => x.type === 'npc_fact');
    assert.equal(fact.expiry, undefined);
    assert.equal(fact.pending, false);
    assert.equal(fact.summary, 'Maren: owes Hesk');
});

test('flag target: an id or a saved name; unknown is null', () => {
    const npcs = [{ id: 'hesk', name: 'Hesk' }, { id: 'marta-ferris', name: 'Marta Ferris' }];
    assert.equal((findPerson('hesk', npcs)?.id ?? null), 'hesk');
    assert.equal((findPerson('Marta Ferris', npcs)?.id ?? null), 'marta-ferris');
    assert.equal((findPerson('nobody', npcs)?.id ?? null), null);
    assert.equal((findPerson('', npcs)?.id ?? null), null);
});
