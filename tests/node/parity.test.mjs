// Production-path tests for the v4 appearance replay. They call decideNpc, fillCandidate,
// recompose, and framesOf — the same functions the chat card and the map channel call.
import './ststub.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { messageKey } from '../../extension/replay.mjs';
import { framesOf, npcAt } from '../../extension/npc.mjs';

await import('../../extension/index.js');
const { decideNpc, fillCandidate, makeOwner, recompose } = await import('../../extension/scene.mjs');

const cast = [{ ok: true, id: 'hesk', name: 'Hesk', line: 'landlady', looks: 'copper braids', body: 'sturdy', outfit: 'wool' }];
const clock = i => ({ elapsed: i * 3600 });

function chatWith(stamps, { elapsedAt = 0 } = {}) {
    const msg = { mes: 'x', is_user: false, swipe_id: 0, swipe_info: [{ extra: {} }], extra: { worldscrawl_npc: [] } };
    messageKey(msg);
    const chat = [msg];
    for (const s of stamps) msg.extra.worldscrawl_npc.push(s);
    return { chat, msg, elapsedAt };
}

test('approve binds the reviewed fields and does not call the model; undo does not resurrect the owner', async () => {
    let calls = 0;
    globalThis.SillyTavern.getContext().generateRaw = async () => { calls++; return '{"body":"no","outfit":"no"}'; };
    const owner = makeOwner({ id: 'hesk', intent: 'taller', fields: 'body', layer: { body: 'a towering woman' }, start: 0, lasts: null, message: 'm1', swipe: 0, chatId: 'c' });
    owner.identity.message = 'm1';
    const { chat, msg } = chatWith([owner]);
    msg.extra.worldscrawl_mid = 'm1';
    owner.candidate.epoch = 0;
    const filled = await fillCandidate(chat, owner.identity, { baseline: { body: 'sturdy', outfit: 'wool' }, name: 'Hesk', elapsed: 0 });
    assert.equal(filled.ok, true, filled.error);
    assert.equal(calls, 0, 'explicit layer text is not a model call');
    const approved = decideNpc(chat, owner.identity, owner.decisionRev, 'approve', { token: owner.candidate.token, elapsed: 0 });
    assert.equal(approved.ok, true);
    assert.equal(calls, 0, 'approve does not call the model');
    assert.equal(owner.committed.layer.body, 'a towering woman');
    const again = decideNpc(chat, owner.identity, owner.decisionRev - 1, 'approve', { token: 'nope' });
    assert.equal(again.stale, true);
    const play = npcAt(chat, 0, cast, 'hesk', clock);
    assert.equal(play.body, 'a towering woman');
    assert.equal(play.pinned.body, 'sturdy');
    const rev = owner.decisionRev;
    const undone = decideNpc(chat, owner.identity, rev, 'undo', {});
    assert.equal(undone.ok, true);
    assert.equal(calls, 0, 'undo of an explicit owner does not call the model');
    assert.equal((msg.extra.worldscrawl_npc ?? []).some(s => s.owner === owner.owner), false);
    const after = npcAt(chat, 0, cast, 'hesk', clock);
    assert.equal(after.body, 'sturdy');
});

test('unknown combination failure stays unresolved and does not keep a removed effect', async () => {
    const a = makeOwner({ id: 'hesk', intent: 'gnoll', fields: 'body', start: 0, lasts: 120, message: 'm', swipe: 0 });
    const b = makeOwner({ id: 'hesk', intent: 'centaur', fields: 'body', start: 0, lasts: 60, message: 'm', swipe: 0 });
    a.committed = { kind: 'appearance', intent: 'gnoll', fields: 'body', layer: {} };
    b.committed = { kind: 'appearance', intent: 'centaur', fields: 'body', layer: {} };
    a.contentId = 'c_gnoll'; b.contentId = 'c_centaur';
    a.candidate = null; b.candidate = null;
    const { chat } = chatWith([a, b]);
    const overlapped = npcAt(chat, 0, cast, 'hesk', () => ({ elapsed: 0 }));
    assert.equal(overlapped.appearanceHow, 'pending');
    assert.equal(overlapped.body, '');
    b.off = true;
    const left = npcAt(chat, 0, cast, 'hesk', () => ({ elapsed: 0 }));
    assert.equal(left.body, '', 'an intent with no layer text stays unresolved rather than showing a removed line');
    assert.equal(left.looks, '');
});

test('both expiry orders and an earlier lasting removal recompute without that contribution', () => {
    const early = makeOwner({ id: 'hesk', intent: 'gnoll', fields: 'body', layer: { body: 'a gnoll frame' }, start: 0, lasts: 120, message: 'm', swipe: 0 });
    const late = makeOwner({ id: 'hesk', intent: 'centaur', fields: 'body', layer: { body: 'a centaur barrel' }, start: 0, lasts: 60, message: 'm', swipe: 0 });
    for (const o of [early, late]) {
        o.committed = { kind: 'appearance', intent: o.intent, fields: 'body', layer: o.candidate.layer };
        o.contentId = `c_${o.intent}`;
        o.candidate = null;
    }
    const { chat } = chatWith([early, late]);
    const hour = npcAt(chat, 0, cast, 'hesk', () => ({ elapsed: 3600 }));
    assert.equal(hour.body, 'a gnoll frame');
    const two = npcAt(chat, 0, cast, 'hesk', () => ({ elapsed: 7200 }));
    assert.equal(two.body, 'sturdy');
    early.off = true;
    const removed = npcAt(chat, 0, cast, 'hesk', () => ({ elapsed: 0 }));
    assert.notEqual(removed.body, 'a gnoll frame');
});

test('a lasting baseline replacement is one replay step and a temp does not enter the lasting result', () => {
    const base = makeOwner({ type: 'npc_baseline', kind: 'baseline', id: 'hesk', field: 'body', text: 'broader shoulders', start: 0, lasts: null, message: 'm', swipe: 0 });
    base.committed = { kind: 'baseline', field: 'body', text: 'broader shoulders' };
    base.contentId = 'c_base';
    base.candidate = null;
    const temp = makeOwner({ id: 'hesk', intent: 'sweaty', fields: 'body', layer: { body: 'broader shoulders, sweaty' }, start: 0, lasts: 60, message: 'm', swipe: 0 });
    temp.committed = { kind: 'appearance', intent: 'sweaty', fields: 'body', layer: { body: 'broader shoulders, sweaty' } };
    temp.contentId = 'c_sweat';
    temp.candidate = null;
    const { chat } = chatWith([base, temp]);
    const live = npcAt(chat, 0, cast, 'hesk', () => ({ elapsed: 0 }));
    assert.equal(live.appearanceHow, 'pending', 'two body operations without a stored combination stay unresolved');
    assert.equal(live.body, '');
    assert.equal(live.lasting.unresolved, false);
    assert.equal(live.lasting.body, 'broader shoulders');
    assert.equal(live.pinned.body, 'sturdy');
    const later = npcAt(chat, 0, cast, 'hesk', () => ({ elapsed: 3600 }));
    assert.equal(later.body, 'broader shoulders');
    assert.equal(later.lasting.body, 'broader shoulders');
});

test('discard during fill leaves the committed owner, and an expired candidate cannot be approved', async () => {
    const owner = makeOwner({ id: 'hesk', intent: 'cut', fields: 'body', layer: { body: 'cropped' }, start: 0, lasts: 30, message: 'm2', swipe: 0 });
    owner.committed = { kind: 'appearance', intent: 'old', fields: 'body', layer: { body: 'original edit' } };
    owner.contentId = 'c_old';
    owner.identity.message = 'm2';
    const { chat, msg } = chatWith([owner]);
    msg.extra.worldscrawl_mid = 'm2';
    const rev = owner.decisionRev;
    const discarded = decideNpc(chat, owner.identity, rev, 'discard', {});
    assert.equal(discarded.ok, true);
    assert.equal(owner.committed.intent, 'old');
    assert.equal(owner.candidate, null);
    owner.candidate = { token: 't', epoch: 0, proposedLasts: 30, kind: 'appearance', intent: 'new', fields: 'body', layer: { body: 'new text' }, phase: 'review', lastingKey: 'k', liveKey: 'k', lastingPreview: { body: 'new text', outfit: 'wool' }, livePreview: { body: 'new text', outfit: 'wool' } };
    owner.decisionRev = discarded.rev;
    const late = decideNpc(chat, owner.identity, owner.decisionRev, 'approve', { token: 't', elapsed: 1800 });
    assert.equal(late.ok, false);
    assert.equal(owner.committed.intent, 'old');
});

test('player undo of the only name stamp drops named; a second memory keeps met; appearance expiry does not', () => {
    const chat = [{ mes: 'b', swipe_id: 0, extra: { worldscrawl_mid: 'x', worldscrawl_npc: [
        { type: 'npc_name', id: 'hesk', who: 'player', swipe: 0, owner: 'n1', identity: { owner: 'n1', message: 'x', swipe: 0, npc: 'hesk', domain: 'npc_name', chat: 'c' }, decisionRev: 1 },
        { type: 'npc_memory', id: 'hesk', note: 'she promised a room', swipe: 0, owner: 'mem1', identity: { owner: 'mem1', message: 'x', swipe: 0, npc: 'hesk', domain: 'npc_memory', chat: 'c' }, decisionRev: 1 },
        { type: 'npc_memory', id: 'hesk', note: 'she laughed', swipe: 0, owner: 'mem2', identity: { owner: 'mem2', message: 'x', swipe: 0, npc: 'hesk', domain: 'npc_memory', chat: 'c' }, decisionRev: 1 },
    ] } }];
    const named = npcAt(chat, 0, cast, 'hesk');
    assert.equal(named.rel.player.state, 'named');
    decideNpc(chat, chat[0].extra.worldscrawl_npc[0].identity, 1, 'undo', {});
    const met = npcAt(chat, 0, cast, 'hesk');
    assert.equal(met.rel.player.state, 'met');
    decideNpc(chat, chat[0].extra.worldscrawl_npc[0].identity, chat[0].extra.worldscrawl_npc[0].decisionRev, 'undo', {});
    const still = npcAt(chat, 0, cast, 'hesk');
    assert.equal(still.rel.player.state, 'met');
    chat[0].extra.worldscrawl_npc.push({ type: 'npc_appearance', id: 'hesk', owner: 'app', swipe: 0, start: 0, lasts: 60, contentId: 'capp', candidate: null, identity: { owner: 'app', message: 'x', swipe: 0, npc: 'hesk', domain: 'appearance', chat: 'c' }, decisionRev: 1, committed: { kind: 'appearance', intent: 'taller', fields: 'body', layer: { body: 'a towering woman' } } });
    const during = npcAt(chat, 0, cast, 'hesk', () => ({ elapsed: 0 }));
    assert.equal(during.body, 'a towering woman');
    assert.equal(during.rel.player.state, 'met');
    const expired = npcAt(chat, 0, cast, 'hesk', () => ({ elapsed: 3600 }));
    assert.equal(expired.body, 'sturdy');
    assert.equal(expired.rel.player.state, 'met');
});

test('recompose of an unknown pair calls the model once and does not add an owner', async () => {
    const fs = await import('node:fs');
    const ext = await import('../../extension/index.js');
    ext.setPrompts(JSON.parse(fs.readFileSync(new URL('../../plugin/prompts/default.json', import.meta.url), 'utf8')));
    let calls = 0;
    globalThis.SillyTavern.getContext().generateRaw = async (args) => {
        calls++;
        if (String(args.prompt).includes('Looks')) return '{"looks":"tall copper braids"}';
        return '{"body":"a gnoll frame","outfit":"wool"}';
    };
    const a = makeOwner({ id: 'hesk', intent: 'gnoll', fields: 'body', start: 0, lasts: null, message: 'm', swipe: 0 });
    const b = makeOwner({ id: 'hesk', intent: 'scarred', fields: 'body', start: 0, lasts: null, message: 'm', swipe: 0 });
    for (const o of [a, b]) {
        o.committed = { kind: 'appearance', intent: o.intent, fields: 'body', layer: {} };
        o.contentId = `c_${o.intent}`;
        o.candidate = null;
    }
    const { chat } = chatWith([a, b]);
    const before = chat[0].extra.worldscrawl_npc.length;
    const res = await recompose(chat, { npc: 'hesk', swipe: 0, baseline: { body: 'sturdy', outfit: 'wool' }, name: 'Hesk', elapsed: 0 });
    assert.equal(res.called, true);
    assert.equal(chat[0].extra.worldscrawl_npc.length, before);
    const play = npcAt(chat, 0, cast, 'hesk', () => ({ elapsed: 0 }));
    assert.equal(play.body, 'a gnoll frame');
    assert.equal(play.outfit, 'wool');
});

test('framesOf replay is stable when the in-memory person is dropped', () => {
    const owner = makeOwner({ id: 'hesk', intent: 'taller', fields: 'body', layer: { body: 'a towering woman' }, start: 0, lasts: null, message: 'm', swipe: 0 });
    owner.committed = { kind: 'appearance', intent: 'taller', fields: 'body', layer: { body: 'a towering woman' } };
    owner.contentId = 'c_tall';
    owner.candidate = null;
    const chat = [{ mes: 'x', swipe_id: 0, extra: { worldscrawl_npc: [owner] } }];
    const first = framesOf(chat, 0, cast, () => ({ elapsed: 0 })).at(-1).get('hesk');
    const second = framesOf(chat, 0, cast, () => ({ elapsed: 0 })).at(-1).get('hesk');
    assert.equal(second.body, first.body);
    assert.equal(second.pinned.body, 'sturdy');
});
