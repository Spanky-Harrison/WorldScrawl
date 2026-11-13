// B1: what the engine itself adds to the narrator's facts block reads as plain story facts, never engine jargon.
// Driven through the real handlers (applyFacts, brackets) like the name-portal canary. Only engine-added text is
// checked: world text (descriptions, lore, cards) is the world's own words, so a world sentence full of jargon is
// planted and must come through untouched without failing the check.
import './ststub.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { RIVERTON, TAVERN, copytree, tmpPath, write, clientDir } from './helpers.mjs';

const ext = await import('../../extension/index.js');
const N = await import('../../extension/names.mjs');
const scene = await import('../../extension/scene.mjs');
const { bracketIntent, parseBracket } = await import('../../extension/brackets.mjs');
const { exitsCache } = await import('../../extension/footer.mjs');
const { rememberWorlds, loadCalendar } = await import('../../extension/clock.mjs');
await loadCalendar();
const PROMPTS = JSON.parse(fs.readFileSync(new URL('../../plugin/prompts/default.json', import.meta.url), 'utf8'));

// World text that happens to use the words the engine must not: it is the world's, so it stays and is not checked.
const WORLD_JARGON = 'The game engine in the cellar is off the map of any guild, and its importance is on file in focus.';
const CARD = {
    id: 'hesk', name: 'Zqxhesk', unknownAs: 'the landlady',
    personality: { summary: 'Stern, watchful, sharp-tongued.', manner: 'Watches the room.', speech: 'Low and quick.' },
    appearance: { summary: 'a big woman with copper braids', body: 'Tall and raw-boned.', outfit: 'Widow\'s black and an apron.' },
    history: 'Came to Riverton as a bargeman\'s daughter.',
    memory: ['Threw a drunk out last week.'],
    schedule: [{ place: TAVERN, activity: 'pouring drinks', from: '00:00', to: '23:59', importance: 'high' }],
};
const ASLEEP = { ...CARD, schedule: [{ activity: 'asleep', where: 'her own room', near: 'riverton:drowned_rat', importance: 'high' }] };
const servers = new Map();
function serverFor(card) {
    if (servers.has(card)) return servers.get(card);
    const d = tmpPath();
    copytree(path.dirname(RIVERTON), d);
    write(path.join(d, 'riverton', 'cast', 'hesk.json'), JSON.stringify(card));
    const rf = path.join(d, 'riverton', 'regions', 'riverton.json');
    write(rf, fs.readFileSync(rf, 'utf8').replace('{{npc:hesk}}.', `{{npc:hesk}}. ${WORLD_JARGON}`));
    const sv = clientDir(d);
    servers.set(card, sv);
    return sv;
}
function boot(card = CARD) {
    exitsCache.clear();
    const server = serverFor(card);
    globalThis.BroadcastChannel = undefined;
    globalThis.document = { querySelector: () => null, querySelectorAll: () => [], getElementById: () => null, createElement: () => ({ style: {}, append() {}, appendChild() {} }), body: {}, documentElement: {} };
    globalThis.fetch = async (url, opts = {}) => {
        const u = new URL(String(url), 'http://local');
        const r = server.request(opts.method || 'GET', u.pathname.replace(/^\/api\/plugins\/worldscrawl/, '') + u.search, { json: opts.body ? JSON.parse(opts.body) : undefined });
        return { ok: r.status_code < 400, status: r.status_code, headers: { get: k => r.headers.get(k) }, json: async () => r.json() };
    };
    ext.setPrompts(PROMPTS);
    rememberWorlds(server.get('/worlds').json());
    const c = SillyTavern.getContext();
    c.chatId = 'words'; c.getCurrentChatId = () => 'words';
    c.chatMetadata = { worldscrawl_enabled: true };
    c.saveChat = async () => {}; c.saveSettingsDebounced = () => {}; c.updateMessageBlock = () => {};
    const blocks = {};
    c.setExtensionPrompt = (key, text) => { blocks[key] = String(text ?? ''); };
    c.registerFunctionTool = () => {}; c.unregisterFunctionTool = () => {};
    c.generateRaw = async () => '';
    Object.assign(ext.settings(), { flagNpcs: true, flagTags: true, autoKeep: false, autoKeepWaits: true, weatherNumbers: false });
    c.chat = [{ is_user: false, mes: 'Welcome.', swipe_id: 0, swipe_info: [{ extra: {} }], extra: { worldscrawl_world: { id: 'riverton', name: 'Riverton' }, worldscrawl_location: TAVERN } }];
    return { c, blocks };
}
const say = (c, text) => { const m = { is_user: true, mes: text, swipe_id: 0, extra: {} }; c.chat.push(m); return m; };
const facts = async blocks => { await scene.applyFacts(); return blocks[ext.FACTS_KEY ?? 'worldscrawl_facts'] ?? Object.values(blocks).find(t => /Current location/.test(t)) ?? ''; };
const bracket = async (c, text) => { const m = say(c, text); await bracketIntent(m, parseBracket(m.mes)); return m; };

/** Engine jargon the narrator must never get from the engine's own lines. */
const JARGON = /\bengine\b|\boff the map\b|\bon file\b|\bimportance\b|\bin focus\b|authoritative|\bNOT moved\b|\bthis turn\b|\(expired|\bDisposition\b|saved people|without travelling|for clarity|\bthe party\b|was temporary/i;
/** The engine-added text: the facts block with every piece of world text (the planted sentence, the lore, the card) taken out. */
const engineText = f => [WORLD_JARGON, CARD.personality.summary, CARD.memory[0], CARD.history].reduce((t, w) => t.split(w).join(''), f);
const jargonIn = f => engineText(f).split('\n').filter(l => JARGON.test(l));

test('jargon: the world\'s own jargon comes through untouched and is not what the check reads', async () => {
    const { c, blocks } = boot();
    await bracket(c, '[lore] The Drowned Rat');
    const f = await facts(blocks);
    assert.ok(f.includes(WORLD_JARGON), 'world text is fed as written');
    assert.deepEqual(jargonIn(f), []);
});

test('jargon: a plain look, people here, the stay-put line and the rules read as story facts', async () => {
    const { c, blocks } = boot();
    say(c, 'I look around.');
    const f = await facts(blocks);
    assert.match(f, /^\[Scene facts\. Treat these as true\.\]/);
    assert.match(f, /People here \(anyone not listed is a background figure, not one of them\):/);
    assert.match(f, new RegExp(`the landlady \\[${N.handleOf('hesk')}\\]:`), 'handles stay');
    assert.match(f, /stays in Common Room \(The Drowned Rat\): no move happens/);
    assert.match(f, /Places with local lore: /);
    assert.deepEqual(jargonIn(f), []);
});

test('jargon: talking to her (focus, memory guard) adds no engine words', async () => {
    const { c, blocks } = boot();
    say(c, 'I talk to the landlady about the drunk.');
    const f = await facts(blocks);
    assert.match(f, /More about the landlady:/);
    assert.doesNotMatch(f, /in focus/);
    assert.deepEqual(jargonIn(f), []);
});

test('jargon: someone asleep elsewhere is "elsewhere", with the keep-out line, and no importance', async () => {
    const { c, blocks } = boot(ASLEEP);
    await bracket(c, '[lore] The Drowned Rat');
    const f = await facts(blocks);
    assert.match(f, /The landlady: asleep, elsewhere \(her own room, in The Drowned Rat\)/);
    assert.match(f, /\(Anyone above who is elsewhere is not with the characters\./);
    assert.deepEqual(jargonIn(f), []);
});

test('jargon: a move and a kept wait read as what happened, with no engine words', async () => {
    let { c, blocks } = boot();
    await bracket(c, '[move] out');
    let f = await facts(blocks);
    assert.match(f, /What just happened: .* moved out from/);
    assert.deepEqual(jargonIn(f), []);
    ({ c, blocks } = boot());
    await bracket(c, '[wait] 8h');
    f = await facts(blocks);
    assert.match(f, /What just happened: .* waited here for 8h, staying put\./);
    assert.deepEqual(jargonIn(f), []);
});

// ---- The weather-numbers setting (default off).
test('weather: by default the narrator gets words only; the setting on adds the numbers', async () => {
    let { c, blocks } = boot();
    say(c, 'I look around.');
    let f = await facts(blocks);
    const wx = f.split('\n').find(l => /^Weather/.test(l));
    assert.ok(wx, 'a weather line');
    assert.doesNotMatch(wx, /\d/, 'no numbers by default');
    assert.match(wx, /\b(bitter|freezing|cold|cool|mild|warm|hot|sweltering)\b/);
    assert.equal(ext.settings().weatherNumbers, false);
    ({ c, blocks } = boot());
    ext.settings().weatherNumbers = true;
    say(c, 'I look around.');
    f = await facts(blocks);
    assert.match(f.split('\n').find(l => /^Weather/.test(l)), /\d+°F.*% humidity/);
    ext.settings().weatherNumbers = false;
});

test('weather: a wait\'s before line follows the setting too', async () => {
    const { c, blocks } = boot();
    await bracket(c, '[wait] 10h');
    const f = await facts(blocks);
    const before = f.split('\n').find(l => /^Before the wait:/.test(l));
    assert.ok(before, 'ten hours later the weather has moved on'); assert.doesNotMatch(before, /\d/);
});

test('weather: placeWeather words carry no numbers for every exposure', async () => {
    const W = await import('../../plugin/shared/weather.mjs');
    const cfg = { unit: 'F', regions: { r: { climate: { spring: { high: 15, low: 5, humidity: 85 } } } }, winds: {} };
    const fixed = W.placeWeather(cfg, { exposure: 'fixed', fixed_weather: { condition: 'Eternal twilight', temp: 15 } }, 0);
    assert.equal(fixed.words, 'Weather here: Eternal twilight, mild.');
    assert.match(fixed.line, /59°F/);
    const enc = W.placeWeather(cfg, { exposure: 'enclosed', weather_region: 'r', indoor_temp: 7 }, 0);
    assert.equal(enc.words, 'Here it is cold and still; no weather reaches this place.');
    assert.equal(W.humidWord(85, 25), 'humid');
    assert.equal(W.humidWord(85, 5), 'damp');
    assert.equal(W.humidWord(25, 5), 'dry');
    assert.equal(W.humidWord(55, 5), '');
});
