// A manual map flag always ends visibly: a proposal card, a "can't show this" note, "no map change found", or an error.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import './ststub.mjs';
const ext = await import('../../extension/index.js');
const pl = await import('../../plugin/ui/patches.mjs');

test('cant reply: a "can\'t show this on the map" note with Retry', () => {
    const ans = pl.readChangeAnswer(ext.parseJsonAnswer('{"cant": "a mind dimension is not a place on the map"}'));
    const v = ext.flagCardView({ status: 'cant', error: ans.cant, start: 3 }, 5);
    assert.equal(v.text, "🗺 Can't show this on the map: a mind dimension is not a place on the map");
    assert.deepEqual(v.buttons, ['Retry', 'Dismiss']);
});
test('empty ops reply: "no map change found" with Retry', () => {
    assert.deepEqual(pl.readChangeAnswer({ ops: [] }), { nothing: true });
    const v = ext.flagCardView({ status: 'nothing', start: 3 }, 5);
    assert.match(v.text, /No map change found in messages #3–#5/);
    assert.ok(v.buttons.includes('Retry'));
});
test('errors and parse failures show in the bar', () => {
    assert.equal(ext.parseJsonAnswer('sorry, no'), null);
    const v = ext.flagCardView({ status: 'error', error: 'map server answered 500', start: 0 }, 1);
    assert.match(v.text, /Map change failed: map server answered 500/);
    assert.ok(v.buttons.includes('Retry'));
});
test('never an empty card: review without a proposal or an unknown state still says something', () => {
    for (const status of ['review', 'weird', undefined]) {
        const v = ext.flagCardView({ status, start: 0 }, 1);
        assert.ok(v && v.text.length > 3 && v.buttons.includes('Retry'), String(status));
    }
    assert.equal(ext.flagCardView({ status: 'review', proposal: { ops: [] }, start: 0 }, 1).buttons[0], 'review');
});
test('Debug > Show map edit messages logs the map-edit call', () => {
    const seen = [], orig = console.info; console.info = (...a) => seen.push(a);
    try {
        ext.settings().showEditMessages = false; ext.logEditCall('the change', 'Q', 'A');
        assert.equal(seen.length, 0);
        ext.settings().showEditMessages = true; ext.logEditCall('the change', 'Q', '{"ops": []}');
        assert.equal(seen.length, 1); assert.match(seen[0][0], /map edit call: the change/); assert.equal(seen[0][1].answer, '{"ops": []}');
    } finally { console.info = orig; ext.settings().showEditMessages = false; }
});
test('the flag button and the analysis cannot fail silently', () => {
    const src = fs.readFileSync(new URL('../../extension/index.js', import.meta.url), 'utf8');
    assert.match(src, /flagMessage\(Number\(el\.getAttribute\('mesid'\)\)\)\.then\([^\n]*toastr\.error/);
    assert.match(src, /analyzeFlag\(id\)\.catch\(/);
    assert.match(src, /try \{\n\s+await ensurePrompts\(\);/);
});
