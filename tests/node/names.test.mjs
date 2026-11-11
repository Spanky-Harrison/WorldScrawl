// The name portal (extension/names.mjs), and the canary: a cast person with a made-up name the model must never be fed
// until the player learns it, driven through the real handlers (applyFacts, onReplyForFlags -> the tracker, brackets).
import './ststub.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { RIVERTON, TAVERN, copytree, tmpPath, write, clientDir } from './helpers.mjs';

const ext = await import('../../extension/index.js');
const N = await import('../../extension/names.mjs');
const { NPC_KEY, npcAt, stampSummary } = await import('../../extension/npc.mjs');
const { onReplyForFlags } = await import('../../extension/discovery.mjs');
const scene = await import('../../extension/scene.mjs');
const { bracketIntent, parseBracket } = await import('../../extension/brackets.mjs');
const { exitsCache } = await import('../../extension/footer.mjs');
const { rememberWorlds, loadCalendar } = await import('../../extension/clock.mjs');
await loadCalendar();

const PROMPTS = JSON.parse(fs.readFileSync(new URL('../../plugin/prompts/default.json', import.meta.url), 'utf8'));

// ---- The canary: Hesk's card with a name that cannot occur by chance, in the common room all day.
export const CANARY = 'Zqxhesk', CANARY_ALIAS = 'Zqxie';
const CANARY_CARD = {
    id: 'hesk', name: CANARY, aliases: [CANARY_ALIAS], unknownAs: 'the landlady',
    personality: { summary: `${CANARY}'s inn: stern, watchful, sharp-tongued.`, manner: 'Watches the room.', speech: 'Low and quick.' },
    appearance: { summary: 'a big woman with copper braids', body: 'Tall and raw-boned.', outfit: 'Widow\'s black and an apron.' },
    history: `${CANARY} came to Riverton as a bargeman's daughter; ${CANARY_ALIAS} to her friends.`,
    memory: [`${CANARY} threw a drunk out last week.`],
    schedule: [{ place: TAVERN, activity: 'pouring drinks', from: '00:00', to: '23:59', importance: 'high' }],
};
// The same card asleep off the map near the Drowned Rat all day: the "Hesk remains asleep" leak path (absentAt).
const ASLEEP_CARD = { ...CANARY_CARD, schedule: [{ activity: 'asleep', where: 'her own room', near: 'riverton:drowned_rat' }] };
const servers = new Map();
function serverFor(card) {
    if (servers.has(card)) return servers.get(card);
    const d = tmpPath();
    copytree(path.dirname(RIVERTON), d);
    write(path.join(d, 'riverton', 'cast', 'hesk.json'), JSON.stringify(card));
    // The tavern lore names her by token and in plain text (with the alias).
    const rf = path.join(d, 'riverton', 'regions', 'riverton.json');
    write(rf, fs.readFileSync(rf, 'utf8').replace('{{npc:hesk}}.', `{{npc:hesk}}. ${CANARY} keeps a cudgel under the bar; regulars call her ${CANARY_ALIAS}.`));
    const sv = clientDir(d);
    servers.set(card, sv);
    return sv;
}

/** A fresh chat in the common room with the canary cast; every model call and every injected block is recorded. */
function boot({ tracker = () => '{"place": null, "people": [], "wait": null}', card = CANARY_CARD } = {}) {
    exitsCache.clear();
    const server = serverFor(card);
    globalThis.fetch = async (url, opts = {}) => {
        const u = new URL(String(url), 'http://local');
        const r = server.request(opts.method || 'GET', u.pathname.replace(/^\/api\/plugins\/worldscrawl/, '') + u.search, { json: opts.body ? JSON.parse(opts.body) : undefined });
        return { ok: r.status_code < 400, status: r.status_code, headers: { get: k => r.headers.get(k) }, json: async () => r.json() };
    };
    ext.setPrompts(PROMPTS);
    rememberWorlds(server.get('/worlds').json());
    const c = SillyTavern.getContext();
    c.chatId = 'canary'; c.getCurrentChatId = () => 'canary';
    c.chatMetadata = { worldscrawl_enabled: true };
    c.saveChat = async () => {}; c.saveSettingsDebounced = () => {}; c.updateMessageBlock = () => {};
    const calls = [], blocks = {};
    c.setExtensionPrompt = (key, text) => { blocks[key] = String(text ?? ''); };
    const tools = {};
    c.registerFunctionTool = t => { tools[t.name] = t; }; c.unregisterFunctionTool = () => {};
    c.generateRaw = async args => {
        const prompt = String(args?.prompt ?? ''), sys = String(args?.systemPrompt ?? '');
        calls.push({ prompt, sys });
        if (/Reply with JSON only:\n\{"place"/.test(prompt)) return tracker(prompt);
        return '';
    };
    Object.assign(ext.settings(), { flagNpcs: true, flagTags: true, autoKeep: false });
    c.chat = [{ is_user: false, mes: 'Welcome.', swipe_id: 0, swipe_info: [{ extra: {} }], extra: { worldscrawl_world: { id: 'riverton', name: 'Riverton' }, worldscrawl_location: TAVERN } }];
    return { c, calls, blocks, tools };
}
const say = (c, text) => { const m = { is_user: true, mes: text, swipe_id: 0, extra: {} }; c.chat.push(m); return m; };
const reply = (c, text) => { const m = { is_user: false, mes: text, swipe_id: 0, swipes: [text], swipe_info: [{ extra: {} }], extra: {} }; c.chat.push(m); return c.chat.length - 1; };
const nameStamps = m => (m.extra?.[NPC_KEY] ?? []).filter(s => s.type === 'npc_name');
const known = c => N.knows(npcAt(c.chat, c.chat.length - 1, scene.castPack().npcs, 'hesk')).known;
const callNotes = m => Object.values(m.extra?.worldscrawl_calls ?? {}).flat();
const handle = () => N.handleOf('hesk');
const nameItem = (id, name = CANARY) => () => JSON.stringify({ place: null, people: [{ id, action: 'name', name }], wait: null });

// ---- The portal itself.
const P = { id: 'hesk', name: 'Hesk', aliases: ['Hessy'], unknownAs: 'the landlady', rel: {} };
const named = { ...P, rel: { player: { state: 'named', at: 1, by: 'name bracket' } } };

test('portal: knows and shownName read the rel record; no unknownAs counts as known', () => {
    assert.deepEqual(N.knows(P), { known: false, reason: 'not known: shown as "the landlady"' });
    assert.deepEqual(N.knows(named), { known: true, reason: 'known: name bracket' });
    assert.equal(N.knows({ id: 'tam', name: 'Tam' }).known, true);
    assert.equal(N.shownName(P), 'the landlady');
    assert.equal(N.shownName(named), 'Hesk');
    assert.equal(N.shownName({ ...P, known: { known: true } }), 'Hesk', 'a presentAt row carries its own known');
});

test('portal: handles are stable per chat, differ between chats, and never carry the cast id', () => {
    N.configureNames({ salt: () => 'chat-a' });
    const a = N.handleOf('hesk');
    assert.match(a, /^p[0-9a-z]{1,4}$/);
    assert.doesNotMatch(a, /hesk/);
    assert.equal(N.handleOf('hesk'), a);
    N.configureNames({ salt: () => 'chat-b' });
    assert.notEqual(N.handleOf('hesk'), a);
    assert.equal(N.labelOf(P), `the landlady [${N.handleOf('hesk')}]`);
});

test('portal: findPerson takes a handle, id, name, alias or unknownAs; an invented id is text; several is nobody', () => {
    const tam = { id: 'tam', name: 'Old Tam', unknownAs: 'the old man' };
    const list = [P, tam];
    assert.equal(N.findPerson(N.handleOf('hesk'), list)?.id, 'hesk');
    assert.equal(N.findPerson('hesk', list)?.id, 'hesk');
    assert.equal(N.findPerson('Hessy', list)?.id, 'hesk');
    assert.equal(N.findPerson('the landlady', list)?.id, 'hesk');
    assert.equal(N.findPerson('landlady', list)?.id, 'hesk');
    assert.equal(N.findPerson('old-tam', list)?.id, 'tam');
    assert.equal(N.findPerson('mo-ran', list), null, 'the player is nobody on the cast');
    assert.equal(N.findPerson('elara', list), null);
    const guards = [{ id: 'g1', name: 'Bors', unknownAs: 'the old guard' }, { id: 'g2', name: 'Ulf', unknownAs: 'the gate guard' }];
    assert.equal(N.findPerson('guard', guards), null);
});

test('portal: judgeLearn wants a present, unnamed person whose name was spoken in quotes or by the player', () => {
    const base = { person: P, present: [P], heard: 'Hesk', said: 'Hello.' };
    assert.equal(N.judgeLearn({ ...base, story: 'She wipes the bar. "Name\'s Hesk," she says.' }).ok, true);
    assert.equal(N.judgeLearn({ ...base, story: '“Hessy, another round!” a docker calls.', heard: 'Hessy' }).ok, true);
    assert.equal(N.judgeLearn({ ...base, said: 'Are you Hesk?', story: 'She nods.' }).ok, true, 'the player\'s own line counts');
    assert.match(N.judgeLearn({ ...base, story: 'Hesk wipes the bar.' }).reason, /not said in dialogue/);
    assert.match(N.judgeLearn({ ...base, present: [], story: '"I\'m Hesk."' }).reason, /not here/);
    assert.match(N.judgeLearn({ ...base, person: named, present: [named], story: '"I\'m Hesk."' }).reason, /already knows/);
    assert.match(N.judgeLearn({ ...base, heard: 'Marta', story: '"I\'m Marta."' }).reason, /not Hesk's name/);
    assert.match(N.judgeLearn({ ...base, person: null }).reason, /no saved person/);
});

test('portal: maskText masks unknown names and aliases, keeps places and other words, renders tokens', () => {
    N.configureNames({ places: () => ["Hesk's Room"] });
    const t = N.maskText("Hesk is asleep. Ask Hesk's cook in Hesk's Room; Heskett and hesk stay. {{npc:hesk}}, {{npc:nobody}}, {{npc!:hesk}}. Hessy!", [P]);
    assert.equal(t, "The landlady is asleep. Ask the landlady's cook in Hesk's Room; Heskett and hesk stay. the landlady, nobody, Hesk. The landlady!");
    assert.equal(N.maskText('Hesk is here. {{npc:hesk}}', [named]), 'Hesk is here. Hesk');
    assert.deepEqual(N.nameLeaks('the landlady and Hesk', [P]), [{ id: 'hesk', name: 'Hesk' }]);
    assert.deepEqual(N.nameLeaks('Hesk is here', [named]), []);
    N.configureNames({ places: () => [] });
});

// ---- The canary through the real handlers.
test('canary inbound: a tracker name item on the player\'s made-up id stamps nobody (no name-only fallback)', async () => {
    const { c } = boot({ tracker: nameItem('mo-ran') });
    say(c, 'I look around.');
    const id = reply(c, `The landlady pours a drink. "${CANARY}, another!" a docker shouts.`);
    await onReplyForFlags(id);
    assert.deepEqual(nameStamps(c.chat[id]), []);
    assert.equal(known(c), false);
    assert.ok(callNotes(c.chat[id]).some(n => n.kind === 'name learn' && /tracker: No saved person/.test(n.reason)));
});

test('canary inbound: the tracker\'s handle learns the name only when it was said in dialogue', async () => {
    let r = boot({ tracker: () => nameItem(handle())() });
    say(r.c, 'I look around.');
    let id = reply(r.c, `${CANARY} pours a drink.`);
    await onReplyForFlags(id);
    assert.deepEqual(nameStamps(r.c.chat[id]), [], 'narration alone is not an introduction');
    assert.ok(callNotes(r.c.chat[id]).some(n => n.kind === 'name learn' && /not said in dialogue/.test(n.reason)));
    r = boot({ tracker: () => nameItem(handle())() });
    say(r.c, 'I ask her name.');
    id = reply(r.c, `She sets down the jug. "${CANARY}," she says. "And you're dripping on my floor."`);
    await onReplyForFlags(id);
    assert.deepEqual(nameStamps(r.c.chat[id]).map(s => [s.id, s.source, s.override]), [['hesk', 'tracker', undefined]]);
    assert.equal(known(r.c), true);
    // Turn off and Undo take the name back at once (read from the stamps, never stored).
    nameStamps(r.c.chat[id])[0].off = true;
    assert.equal(known(r.c), false);
    r.c.chat[id].extra[NPC_KEY] = r.c.chat[id].extra[NPC_KEY].filter(s => s.type !== 'npc_name');
    assert.equal(known(r.c), false);
});

test('canary inbound: an alias said in dialogue counts; someone not in the scene is not learned', async () => {
    let r = boot({ tracker: () => nameItem(handle(), CANARY_ALIAS)() });
    say(r.c, 'Hello.');
    let id = reply(r.c, `"${CANARY_ALIAS}! Ale!" someone yells, and the landlady scowls.`);
    await onReplyForFlags(id);
    assert.equal(nameStamps(r.c.chat[id]).length, 1);
    // Upstairs, she is not here: the same dialogue learns nothing.
    r = boot({ tracker: () => nameItem(handle())() });
    r.c.chat[0].extra.worldscrawl_location = 'riverton:drowned_rat/upstairs';
    say(r.c, 'Hello.');
    id = reply(r.c, `"${CANARY} is downstairs," a guest says.`);
    await onReplyForFlags(id);
    assert.deepEqual(nameStamps(r.c.chat[id]), []);
    assert.ok(callNotes(r.c.chat[id]).some(n => n.kind === 'name learn' && /is not here/.test(n.reason)));
});

test('canary inbound: the narrator\'s name flag follows the same rules', async () => {
    let r = boot();
    say(r.c, 'Hello.');
    let id = reply(r.c, `The landlady nods. [ws_flag: name | ${CANARY}]`);
    await onReplyForFlags(id);
    assert.deepEqual(nameStamps(r.c.chat[id]), []);
    assert.doesNotMatch(r.c.chat[id].mes, /ws_flag/, 'the tag is still taken out of the text');
    r = boot();
    say(r.c, 'Hello.');
    id = reply(r.c, `"Call me ${CANARY}." [ws_flag: name | ${CANARY}]`);
    await onReplyForFlags(id);
    assert.deepEqual(nameStamps(r.c.chat[id]).map(s => s.source), ['flag']);
});

test('canary inbound: the player\'s [name] always lands, and the skipped rule is kept as an override', async () => {
    const { c } = boot();
    c.chat[0].extra.worldscrawl_location = 'riverton:drowned_rat/upstairs';
    const user = say(c, `I [name] ${CANARY}`);
    const r = await bracketIntent(user, parseBracket(user.mes));
    assert.equal(r.kind, 'name');
    const [s] = nameStamps(user);
    assert.equal(s.source, 'bracket');
    assert.match(s.override, /not here/);
    assert.match(stampSummary(s, CANARY), /player override: .*not here/);
    assert.equal(known(c), true);
    const nobody = say(c, 'I [name] Elara');
    assert.match((await scene.learnNameOn(nobody, 'Elara')).reason, /No saved person is called "Elara"/);
});

// ---- Narrator outbound (S2): the facts block is the prompt choke point.
const GATE = new RegExp(`^.*If the landlady is introduced or called by name in spoken dialogue, their name is ${CANARY}\\..*$`, 'm');
const leaks = text => [CANARY, CANARY_ALIAS, '[hesk]', '(hesk)'].filter(w => text.includes(w));
const facts = async blocks => { await scene.applyFacts(); return blocks[ext.FACTS_KEY ?? 'worldscrawl_facts'] ?? Object.values(blocks).find(t => /People here/.test(t)) ?? ''; };

test('canary narrator: present and unknown, she is "the landlady [handle]", with the gated name line and nothing else', async () => {
    const { c, blocks } = boot();
    say(c, 'I look around.');
    const f = await facts(blocks);
    assert.match(f, new RegExp(`the landlady \\[${handle()}\\]:`));
    assert.match(f, GATE, 'the one gated line while she is here');
    assert.equal(f.match(new RegExp(CANARY, 'g')).length, 1);
    assert.deepEqual(leaks(f.replace(GATE, '')), [], 'demeanor, memory and everything else are masked; no cast id');
    assert.match(f, /The landlady's inn: stern/);
});

test('canary narrator: once [name] lands she is named, and the gated line goes away', async () => {
    const { c, blocks } = boot();
    const m = say(c, `I [name] ${CANARY}`);
    await bracketIntent(m, parseBracket(m.mes));
    const f = await facts(blocks);
    assert.match(f, new RegExp(`${CANARY} \\[${handle()}\\]:`));
    assert.doesNotMatch(f, GATE);
});

test('canary narrator: asleep off the map, fed lore with her token and her plain name: never the name (the Hesk leak)', async () => {
    const { c, blocks } = boot({ card: ASLEEP_CARD });
    const m = say(c, '[lore] The Drowned Rat');
    await bracketIntent(m, parseBracket(m.mes));
    const f = await facts(blocks);
    assert.match(f, /The landlady: asleep, somewhere off the map/);
    assert.match(f, /run by its sharp-tongued landlady, the landlady\. The landlady keeps a cudgel under the bar; regulars call her the landlady\./);
    assert.doesNotMatch(f, GATE, 'no gated line while she is not here');
    assert.deepEqual(leaks(f), []);
});

test('canary narrator: the lore tool answers about her by shown name, history masked', async () => {
    const { c, tools } = boot();
    ext.settings().flagTools = true;
    const { registerTools } = await import('../../extension/discovery.mjs');
    registerTools(new Set(['ws_flag']));
    say(c, 'Who is she?');
    const out = await tools.ws_flag.action({ action: 'lore', note: 'the landlady' });
    assert.match(out, /^The landlady's history: The landlady came to Riverton as a bargeman's daughter; the landlady to her friends\.$/);
    delete ext.settings().flagTools;
});

test('canary narrator: the ws_npc tool takes her handle (detail answers masked; a tag by handle lands on her)', async () => {
    const { c, tools } = boot();
    const { registerTools } = await import('../../extension/discovery.mjs');
    registerTools(new Set(['ws_npc']));
    say(c, 'I look at the landlady.');
    const out = await tools.ws_npc.action({ action: 'detail', id: handle() });
    assert.match(out, /^Personality: The landlady's inn/);
    assert.deepEqual(leaks(out), []);
    assert.equal(await tools.ws_npc.action({ action: 'detail', id: 'nobody' }), 'No saved person with that id is here.');
    const id = reply(c, `She glares. [ws_npc: fact | ${handle()} | a scar on her knuckle]`);
    await onReplyForFlags(id);
    assert.ok((c.chat[id].extra[NPC_KEY] ?? []).some(s => s.type === 'npc_fact' && s.id === 'hesk'), 'stored under the cast id');
});

// ---- Side calls (S3): every model call but the narrator's sees the same view; the story and player line are theirs.
const engineOnly = (call, ...theirs) => theirs.reduce((t, x) => t.split(x).join(''), `${call.sys}\n${call.prompt}`);

test('canary side calls: the tracker lists her as "the landlady [handle]"; after [name], by name', async () => {
    const { c, calls } = boot();
    say(c, 'I nod to the woman at the bar.');
    let id = reply(c, 'The landlady wipes a mug and says nothing.');
    await onReplyForFlags(id);
    let t = calls.find(x => /Reply with JSON only:\n\{"place"/.test(x.prompt));
    assert.ok(t, 'the tracker ran');
    assert.match(t.prompt, new RegExp(`the landlady \\[${handle()}\\]`));
    assert.deepEqual(leaks(t.prompt), [], 'not her name, alias, or cast id; her memory and demeanor are masked');
    const m = say(c, `I [name] ${CANARY}`);
    await bracketIntent(m, parseBracket(m.mes));
    calls.length = 0;
    id = reply(c, 'She nods.');
    await onReplyForFlags(id);
    t = calls.find(x => /Reply with JSON only:\n\{"place"/.test(x.prompt));
    assert.match(t.prompt, new RegExp(`${CANARY} \\[${handle()}\\]`));
});

test('canary side calls: first-meeting disposition and the appearance rebuild never see her name', async () => {
    const { c, calls, tools } = boot();
    const said = 'I wave at everyone in the room.';
    const user = say(c, said);
    await scene.prepareNpcs(user);
    const dispo = calls.find(x => /friendly/.test(x.prompt) && /indifferent/.test(x.prompt));
    assert.ok(dispo, 'the disposition question ran');
    assert.match(dispo.prompt, /the landlady/i);
    assert.deepEqual(leaks(engineOnly(dispo, said)), []);
    calls.length = 0;
    const { registerTools } = await import('../../extension/discovery.mjs');
    registerTools(new Set(['ws_npc']));
    const id = reply(c, `Her braids turn white. [ws_npc: appearance | ${handle()} | hair turned white | looks,body | 1 hour]`);
    await onReplyForFlags(id);
    const rebuild = calls.filter(x => /body/i.test(x.prompt) && !/Reply with JSON only:\n\{"place"/.test(x.prompt));
    assert.ok(rebuild.length, 'the appearance rebuild ran');
    for (const r of rebuild) assert.deepEqual(leaks(engineOnly(r)), [], r.prompt);
    assert.ok(rebuild.some(r => /the landlady/i.test(r.prompt)));
});
