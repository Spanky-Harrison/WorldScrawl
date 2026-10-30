// Lore: file keys, the lore chain, requests, the fed block, the index line and {{npc:id}} tokens.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { load_world } from '../../plugin/world.mjs';
import { loreScope, takeLoreFlags, loreIndexLine, loreFor, addLoreRequest, loreRequests, activeLore, loreBlock, renderNpcTokens } from '../../plugin/npc.mjs';
import { makeWorld, tmpPath } from './helpers.mjs';

const region = () => ({ name: 'Riverton', lore: 'A river town.', start: 'inn/common', subregions: {
    inn: { name: 'The Drowned Rat', lore: 'Run by {{npc:hesk}}.', locations: {
        common: { name: 'Common Room', description: 'Smoky.', lore: 'The hearth never goes out.', exits: [{ direction: 'up', to: 'loft' }] },
        loft: { name: 'Loft', description: 'Dusty.', inherit_subregion_lore: false, exits: [{ direction: 'down', to: 'common' }] },
    } },
} });
const load = () => load_world(makeWorld(tmpPath(), { r: region() }));

test('lore loads; the chain is innermost first and follows inherit rules', () => {
    const w = load();
    assert.deepEqual(w.lore_chain(w.get('r:inn/common')).map(c => [c.level, c.name]), [['room', 'Common Room'], ['subregion', 'The Drowned Rat'], ['region', 'Riverton']]);
    assert.deepEqual(w.lore_chain(w.get('r:inn/loft')).map(c => c.level), ['region'], 'inherit_subregion_lore: false drops the area lore');
    const d = w.to_dict(w.get('r:inn/common'));
    assert.equal(d.lore, 'The hearth never goes out.');
    assert.equal(d.lore_chain.length, 3);
});
test('the shipped worlds use lore, not notes', () => {
    const dir = new URL('../../worlds/riverton/regions/', import.meta.url);
    for (const f of fs.readdirSync(dir)) assert.ok(!/"(inherit_(region_|subregion_)?)?notes"\s*:/.test(fs.readFileSync(new URL(f, dir), 'utf8')), f);
});
const chain = [{ level: 'subregion', name: 'The Drowned Rat', text: 'Run by {{npc:hesk}}.' }, { level: 'region', name: 'Riverton', text: 'A river town.' }];
test('index line, lookup and the background-knowledge block', () => {
    assert.equal(loreIndexLine(chain), 'Lore on file: The Drowned Rat, Riverton');
    assert.equal(loreIndexLine([]), '');
    assert.deepEqual(loreFor(chain, 'drowned rat').map(c => c.level), ['subregion']);
    assert.deepEqual(loreFor(chain, '').map(c => c.level), ['subregion', 'region']);
    assert.deepEqual(loreFor(chain, 'Larkspur'), []);
    assert.match(loreBlock([chain[1]]), /^Background knowledge \(lore[^\n]*\n- Riverton: A river town\.$/);
    assert.equal(loreBlock([]), '');
});
test('takeLoreFlags strips the tags and returns the places', () => {
    const r = takeLoreFlags('She pours.\n[ws_flag: lore | The Drowned Rat] [ws_flag: lore]');
    assert.deepEqual(r.places, ['The Drowned Rat', '']);
    assert.equal(r.text.trim(), 'She pours.');
});
test('requests stick for the scene at that place and stop when the place changes', () => {
    const at = ['a', 'a', 'a', 'b', 'b'];
    const chat = at.map((_, i) => ({ is_user: i % 2 === 0, mes: 'x', extra: {} }));
    addLoreRequest(chat[1], { place: 'The Drowned Rat', level: 'subregion', address: 'a', source: 'flag' });
    assert.deepEqual(chat[1].extra.worldscrawl_lore, [{ swipe: 0, place: 'The Drowned Rat', level: 'subregion', address: 'a', source: 'flag' }]);
    const playerAt = i => at[Math.min(i, at.length - 1)];
    assert.deepEqual(activeLore(chat, 2, chain, playerAt).map(c => c.level), ['subregion']);
    assert.deepEqual(activeLore(chat, 4, chain, playerAt), [], 'moved on: not fed');
    assert.deepEqual(activeLore(chat, 4, chain, playerAt, [{ place: '', source: 'bracket' }]).map(c => c.level), ['subregion', 'region']);
    assert.deepEqual(loreRequests(chat), [{ index: 1, place: 'The Drowned Rat', level: 'subregion', address: 'a', source: 'flag' }]);
});
test('{{npc:id}} renders as the cast name; unknown ids show bare and warn', () => {
    const seen = [];
    assert.equal(renderNpcTokens('Run by {{npc:hesk}} and {{npc:nobody}}.', [{ id: 'hesk', name: 'Hesk' }], id => seen.push(id)), 'Run by Hesk and nobody.');
    assert.deepEqual(seen, ['nobody']);
});

const RAT = 'riverton:drowned_rat/common_room', STABLE = 'riverton:drowned_rat/stable', SQUARE = 'riverton:streets/square';
const ratChain = [{ level: 'subregion', name: 'The Drowned Rat', text: 'An inn.' }, { level: 'region', name: 'Riverton', text: 'A town.' }];
const walk = at => ({ chat: at.map((_, i) => ({ is_user: i % 2 === 0, mes: 'x', extra: {} })), playerAt: i => at[Math.min(i, at.length - 1)] });
test('loreScope covers room, subregion and region', () => {
    assert.equal(loreScope(RAT, 'room'), RAT);
    assert.equal(loreScope(RAT, 'subregion'), 'riverton:drowned_rat');
    assert.equal(loreScope(RAT, 'region'), 'riverton');
});
test('subregion lore asked in the common room stays fed in the stable, and drops once out of the building', () => {
    const { chat, playerAt } = walk([RAT, RAT, STABLE, STABLE, SQUARE, SQUARE, RAT]);
    addLoreRequest(chat[1], { place: 'The Drowned Rat', level: 'subregion', address: RAT, source: 'bracket' });
    assert.deepEqual(activeLore(chat, 3, ratChain, playerAt).map(c => c.level), ['subregion'], 'stable: still fed');
    assert.deepEqual(activeLore(chat, 5, ratChain, playerAt), [], 'square: dropped');
    assert.deepEqual(activeLore(chat, 6, ratChain, playerAt), [], 'back inside later: not revived');
});
test('region lore survives moving between buildings in the region', () => {
    const { chat, playerAt } = walk([RAT, RAT, SQUARE, STABLE, 'larkspur:farm/yard']);
    addLoreRequest(chat[1], { place: 'Riverton', level: 'region', address: RAT, source: 'flag' });
    assert.deepEqual(activeLore(chat, 2, ratChain, playerAt).map(c => c.level), ['region']);
    assert.deepEqual(activeLore(chat, 3, ratChain, playerAt).map(c => c.level), ['region']);
    assert.deepEqual(activeLore(chat, 4, ratChain, playerAt), [], 'another region: dropped');
});
test("level '' requests keep the exact-room rule", () => {
    const { chat, playerAt } = walk([RAT, RAT, STABLE]);
    addLoreRequest(chat[1], { place: 'Drowned Rat', level: '', address: RAT, source: 'bracket' });
    assert.deepEqual(activeLore(chat, 1, ratChain, playerAt).map(c => c.level), ['subregion']);
    assert.deepEqual(activeLore(chat, 2, ratChain, playerAt), []);
});
