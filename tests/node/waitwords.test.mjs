// Loose wait amounts for [wait], [sleep] and /ws-wait, and the small model call used when even those can't be read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './ststub.mjs';
import './useprompts.mjs';
import * as cal from '../../plugin/ui/calendar.mjs';
const { parseWait, waitWords } = cal;
const ext = await import('../../extension/index.js');
const H = 3600, M = 60;

test('loose spoken amounts', () => {
    const cases = { '1 hour and 1 minute': H + M, 'for 1 hour and 1 minute': H + M, 'an hour': H, 'half an hour': H / 2, 'an hour and a half': 1.5 * H,
        '2 hours 30 minutes': 2.5 * H, '2 hours, 30 minutes': 2.5 * H, '90 min': 90 * M, 'a day': 86400, 'about two hours': 2 * H, 'a couple of hours': 2 * H,
        'for about 20 minutes': 20 * M, '1h30m': 1.5 * H, '1d6h': 30 * H, '2 days': 2 * 86400, '1 hr 15 mins': 75 * M, 'an hour.': H };
    for (const [t, s] of Object.entries(cases)) assert.deepEqual(parseWait(t), { seconds: s }, t);
});
test('until a time of day or a clock time', () => {
    assert.deepEqual(parseWait('until dawn'), { until: 'dawn' });
    assert.deepEqual(parseWait('until 14:30'), { until: '14:30' });
});
test('a day follows the world calendar', () => assert.equal(waitWords('a day', 30 * H), 30 * H));
test('unreadable amounts fail with a "wait" message, not "travel time"', () => {
    for (const bad of ['banana', 'for a while', '1 and', 'hour banana']) assert.throws(() => parseWait(bad), e => /^wait must look like/.test(e.message) && !/travel/.test(e.message), bad);
    assert.throws(() => parseWait('0 minutes'), /longer than zero/);
});
const withModel = async (answer, fn) => {
    const old = globalThis.SillyTavern, asked = [];
    const real = old.getContext();
    globalThis.SillyTavern = { getContext: () => new Proxy({}, { get: (t, k) => k === 'generateRaw' ? async a => { asked.push(a); return answer; } : real[k] }) };
    try { return await fn(asked); } finally { globalThis.SillyTavern = old; }
};
test('model fallback: seconds or until, checked; junk gives null', async () => {
    await withModel('{"seconds": 4500}', async asked => {
        assert.deepEqual(await ext.modelWait('a bit over an hour', null, cal), { seconds: 4500 });
        assert.match(asked[0].prompt, /a bit over an hour/); assert.match(asked[0].systemPrompt, /"seconds": N/);
    });
    await withModel('{"until": "dawn"}', async () => assert.deepEqual(await ext.modelWait('till first light', null, cal), { until: 'dawn' }));
    await withModel('{"unknown": true}', async () => assert.equal(await ext.modelWait('for a while', null, cal), null));
    await withModel('{"until": "lunchtime"}', async () => assert.equal(await ext.modelWait('till lunch', null, cal), null));
    await withModel('no idea', async () => assert.equal(await ext.modelWait('xyz', null, cal), null));
});
