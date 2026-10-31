// Narrator waits (ws_wait tool, [ws_wait] tag, ws_flag wait) wait for the player on a Keep / Adjust / Discard card.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import './ststub.mjs';
const def = JSON.parse(fs.readFileSync(new URL('../../plugin/prompts/default.json', import.meta.url), 'utf8'));
const ext = await import('../../extension/index.js');
ext.setPrompts(def);
const byId = Object.fromEntries(def.prompts.map(e => [e.id, e]));

test('the card stores the amount as the player would type it', () => {
    const m = {};
    ext.proposeWait(m, { seconds: 7200, sleep: false, label: 'waited 2h' });
    assert.equal(m.extra.worldscrawl_waitcard.seconds, 7200);
    assert.ok(!m.extra.worldscrawl_wait, 'nothing stamped until Keep');
    assert.equal(ext.waitAmount({ until: 'dawn', seconds: 1 }), 'until dawn');
});
test('Auto-keep waits defaults to off', () => {
    const src = fs.readFileSync(new URL('../../extension/index.js', import.meta.url), 'utf8');
    assert.match(src, /autoKeepWaits: false/);
});
test('wait wording is in the prompt file: clearly 15 minutes or more, best guess, not dialogue or travel, if unclear don\'t', () => {
    for (const id of ['narration.wait_hint', 'narration.wait_tool']) {
        const t = byId[id].text;
        assert.ok(byId[id].locked, id);
        for (const w of ['clearly take 15 minutes or more', 'a long meal', 'searching a room', 'crafting', 'explicit time skip', 'best guess', 'travel', 'exchange of dialogue', 'single action', "If it isn't clear, don't", 'reason']) assert.ok(t.includes(w), `${id}: ${w}`);
        for (const w of ['meal or conversation', 'when in doubt']) assert.ok(!t.includes(w), `${id}: no ${w}`);
    }
    assert.match(byId['narration.wait_hint'].text, /\[ws_wait: 45m \| searching the cellar\]/);
    assert.match(byId['narration.flag_action'].text, /isn't clear, don't/);
    assert.equal(ext.render('narration.wait_tool'), byId['narration.wait_tool'].text);
});
test('guardrail: narrator waits under 15 minutes are ignored (no card, no clock change)', () => {
    const user = [{ is_user: true, mes: 'I eat', extra: {} }];
    assert.equal(ext.narratorWaitAction(user, { seconds: 14 * 60 }), 'short');
    assert.equal(ext.narratorWaitAction(user, { seconds: 15 * 60 }), 'card');
    assert.equal(ext.narratorWaitAction(user, { seconds: 3600 }, true), 'keep');
});
test('guardrail: explicit waits (/ws-wait, [wait]) already applied, so a narrator wait on that turn is ignored', () => {
    const slash = [{ is_user: true, mes: 'hi', extra: {} }, { is_user: true, mes: '*K waits for 2h.*', extra: { worldscrawl_engine: true, worldscrawl_wait: { seconds: 7200 } } }];
    assert.equal(ext.narratorWaitAction(slash, { seconds: 3600 }), 'explicit');
    const bracket = [{ is_user: true, mes: 'I [wait] 2h', extra: { worldscrawl_wait: { seconds: 7200 } } }];
    assert.equal(ext.narratorWaitAction(bracket, { seconds: 3600 }), 'explicit');
    const older = [{ is_user: true, mes: 'x', extra: { worldscrawl_wait: { seconds: 7200 } } }, { mes: 'reply' }, { is_user: true, mes: 'now', extra: {} }];
    assert.equal(ext.narratorWaitAction(older, { seconds: 3600 }), 'card', 'an earlier turn\'s wait does not count');
});
