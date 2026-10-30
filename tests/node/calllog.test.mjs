import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addCallNote, callNotes, markCall, narratorNote, CALLS_KEY, CALL_CAP } from '../../extension/calllog.mjs';
import { messageActivity } from '../../extension/activity.mjs';
import { timeLabel, elapsedText } from '../../extension/timelabels.mjs';
import { dateAt, clockAt } from '../../plugin/ui/calendar.mjs';

test('call notes: per swipe, retries merge, capped and truncated, mirrored to swipe_info, shown in the activity log', () => {
    const msg = { mes: 'x', swipe_id: 0, swipe_info: [{ extra: {} }, { extra: {} }], extra: {} };
    addCallNote(msg, { kind: 'pick: expiry', status: 'ok', answer: 'zzz' });
    markCall(msg, 'pick: expiry', 'failed', 'answer matched no option');
    addCallNote(msg, { kind: 'pick: expiry', status: 'ok', answer: 'b', retry: true });
    assert.deepEqual(callNotes(msg).map(n => [n.kind, n.status, n.tries, n.reason]), [['pick: expiry', 'ok', 2, undefined]]);
    addCallNote(msg, narratorNote([]));
    assert.equal(callNotes(msg)[1].reason, 'narrator made no tool call');
    assert.equal(msg.swipe_info[1].extra[CALLS_KEY], msg.extra[CALLS_KEY]);
    // swipe 1: ST swaps extra; notes for swipe 0 survive via swipe_info
    msg.swipe_id = 1; msg.extra = {};
    addCallNote(msg, narratorNote(['ws_flag discover', 'npc_fact tag']));
    assert.deepEqual(callNotes(msg)[0].emitted, ['ws_flag discover', 'npc_fact tag']);
    assert.equal(callNotes(msg, 0).length, 2);
    for (let i = 0; i < 30; i++) addCallNote(msg, { kind: `k${i}`, status: 'failed', reason: 'r'.repeat(500) });
    assert.equal(callNotes(msg).length, CALL_CAP);
    assert.ok(callNotes(msg)[0].reason.length <= 120);
    const e = messageActivity(msg, 3).filter(x => x.kind === 'call');
    assert.equal(e.length, CALL_CAP);
    assert.equal(e[0].status, 'failed');
    msg.swipe_id = 0;
    assert.match(messageActivity(msg, 3).find(x => x.kind === 'call').label, /pick: expiry/);
    // survives a save/reload (plain JSON)
    assert.equal(callNotes(JSON.parse(JSON.stringify(msg))).length, 2);
});

test('game-time labels: live from the clock, day on rollover, elapsed over a few minutes', () => {
    const start = { year: 1, month: null, day: 1, time: '07:00' };
    const narr = mes => ({ mes, extra: {} }), you = { is_user: true, mes: 'u', extra: {} };
    const wait = s => ({ mes: 'w', extra: { worldscrawl_wait: { seconds: s } } });
    const chat = [narr('a'), you, narr('b'), you, { ...wait(2 * 3600) }, you, narr('c'), you, wait(20 * 3600)];
    const opts = () => ({ clock: j => clockAt(chat, j), date: s => dateAt(s, start), startDay: dateAt(0, start).day_number });
    const L = i => timeLabel(chat, i, opts())?.text ?? null;
    assert.equal(L(0), 'Day 1, 7:00 AM');
    assert.equal(L(1), null);
    assert.equal(L(2), '7:00 AM');
    assert.equal(L(4), '9:00 AM (+2h)');
    assert.equal(L(8), 'Day 2, 5:00 AM (+20h)');
    // edit the earlier wait: later labels move (nothing stored)
    chat[4].extra.worldscrawl_wait.seconds = 60;
    assert.equal(L(4), '7:01 AM');
    assert.equal(L(6), '7:01 AM');
    delete chat[4].extra.worldscrawl_wait;
    assert.equal(L(8), 'Day 2, 3:00 AM (+20h)');
    assert.ok(!JSON.stringify(chat).includes('AM'));
    assert.equal(elapsedText(90061), '+1d1h');
});
