// R5.4 (prompt revision, the last test of R5): every model call's text comes from a prompt id, side calls included.
// Every default.json entry is replaced by its marker ⟦id⟧ (pieces too). One scripted pass through the real handlers
// (the generation interceptor, bracketIntent, applyFacts, the tracker after a reply, the cards' own calls) records every
// generateRaw call's prompt and systemPrompt (named by callKind, the gen kind label) and the narrator's
// setExtensionPrompt text. (a) With bare markers, what is left of each call once the markers and the known data spans
// are taken out is only whitespace or punctuation: any other English is code-built prompt text, named by its call.
// (b) With each marker followed by its own placeholders (so the pieces filled into it come through), every prompt id
// shows up in at least one call, or is on the allowlist below with its reason: a dead entry shows up.
import './ststub.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { RIVERTON, TAVERN, SQUARE, YARD, copytree, tmpPath, write, clientDir, MARK, markerPrompts, useLiveCalls, callKind } from './helpers.mjs';

class Chan {
    static all = [];
    constructor(name) { this.name = name; this.listeners = []; Chan.all.push(this); }
    addEventListener(type, fn) { if (type === 'message') this.listeners.push(fn); }
    postMessage(data) { for (const ch of Chan.all) if (ch !== this && ch.name === this.name) for (const fn of [...ch.listeners]) fn({ data }); }
    close() {}
}
globalThis.BroadcastChannel = Chan; // the map channel opened at init: the map window's Expand comes in on it
globalThis.getComputedStyle = () => ({ getPropertyValue: () => '' });
const ext = await import('../../extension/index.js');
const work = await import('../../extension/work.mjs');
const cards = await import('../../extension/cardacts.mjs');
const { toggleChange } = await import('../../extension/patches.mjs');
const N = await import('../../extension/names.mjs');
const placeform = await import('../../plugin/ui/placeform.mjs');
const scene = await import('../../extension/scene.mjs');
const { NPC_KEY } = await import('../../extension/npc.mjs');
const { onStorySwipe, onReplyForFlags } = await import('../../extension/discovery.mjs');
const { exitsCache } = await import('../../extension/footer.mjs');
const { rememberWorlds, loadCalendar } = await import('../../extension/clock.mjs');
await loadCalendar();
useLiveCalls(work.liveCalls);
const { FACTS_KEY, REMINDER_KEY } = ext;
const DEF = JSON.parse(fs.readFileSync(new URL('../../plugin/prompts/default.json', import.meta.url), 'utf8'));
const DUMP = !!process.env.R5_DUMP;

// ---- the world: Riverton, the common room's back door locked, the courtyard's kitchen door a plain door to open and close.
const HESK = {
    id: 'hesk', name: 'Zqxhesk', unknownAs: 'the landlady',
    personality: { summary: 'Stern, watchful, sharp-tongued.', manner: 'Watches the room.', speech: 'Low and quick.' },
    appearance: { summary: 'a big woman with copper braids', body: 'Tall and raw-boned.', outfit: 'Widow\'s black and an apron.' },
    deep: { history: 'Came to Riverton as a bargeman\'s daughter.', secrets: ['owes the brewer money'], relationships: { Bryn: 'an old friend' } }, memory: ['Threw a drunk out last week.'], facts: ['keeps the keys'],
    disposition: { player: { value: 'wary', reason: 'a broken mug' } },
    schedule: [{ place: TAVERN, activity: 'pouring drinks', from: '06:00', to: '20:00', importance: 'high' }, { place: SQUARE, activity: 'walking the square', from: '20:00', to: '22:00' }, { activity: 'asleep', where: 'her own room', near: 'riverton:drowned_rat', from: '22:00', to: '06:00' }],
};
const LANE = 'riverton:streets/market_lane', BOOTH = 'riverton:streets/stall';
const BRYN = { id: 'bryn', name: 'Bryn', personality: { summary: 'Bryn, a carter.' }, disposition: { player: { value: 'indifferent' } },
    schedule: [{ might: [YARD, TAVERN], activity: 'loading a cart', from: '06:00', to: '09:00' }, { place: TAVERN, activity: 'drinking', from: '09:00', to: '23:00' },
        { might: [SQUARE, LANE], activity: 'wandering home', from: '23:00', to: '06:00' }] };
let world = null;
function worldOnce() {
    if (world) return world;
    const d = tmpPath();
    copytree(path.dirname(RIVERTON), d);
    const reg = path.join(d, 'riverton', 'regions', 'riverton.json');
    // The back door is locked and lets sound through; the front door has a window in it; the kitchen door is thick;
    // the common room looks out on the square (a view): every glimpse and listen line has a door to come from.
    const txt = fs.readFileSync(reg, 'utf8')
        .replace('"description": "A back door to the courtyard.", "barrier": {}', '"description": "A back door to the courtyard.", "barrier": { "locked": true, "closed_sound": "clear" }')
        .replace('"description": "The front door opens onto the village square.", "barrier": {}', '"description": "The front door opens onto the village square.", "barrier": { "closed_sight": "clear" }')
        .replace('"description": "The kitchen door.", "barrier": {}', '"description": "The kitchen door.", "barrier": { "closed_sound": "none" }')
        .replace('"description": "Across the yard to the stable." }', '"description": "Across the yard to the stable.", "barrier": { "openable": false } }')
        .replace('"description": "A muddy lane slopes down to the river." }', '"description": "A muddy lane slopes down to the river.", "traversal": "The lane is slick with river mud." }')
        .replace('"name": "Common Room",', '"name": "Common Room", "views": ["riverton:streets/market_lane", "riverton:docks/piers"],');
    for (const k of ['"closed_sound": "clear"', '"closed_sight": "clear"', '"closed_sound": "none"', '"views"']) assert.ok(txt.includes(k), `fixture: ${k}`);
    fs.writeFileSync(reg, txt);
    for (const c of [HESK, BRYN]) write(path.join(d, 'riverton', 'cast', `${c.id}.json`), JSON.stringify(c, null, 2));
    world = { server: clientDir(d) };
    return world;
}

// ---- the fake model: answers by call kind (a step may override one); every call recorded.
const DEFAULT_ANSWERS = {
    tracker: '{"place": null, "people": [], "wait": null}',
};
let n = 0;
function boot(prompts, { time = '10:00', here = TAVERN, mode = 'buttons', chat = null, settings = {} } = {}) {
    exitsCache.clear();
    const { server } = worldOnce();
    globalThis.BroadcastChannel = Chan;
    globalThis.document = { querySelector: () => null, querySelectorAll: () => [], getElementById: () => null, createElement: () => ({ style: {}, append() {}, appendChild() {}, setAttribute() {} }), body: {}, documentElement: {} };
    globalThis.fetch = async (url, opts = {}) => {
        const u = new URL(String(url), 'http://local');
        const route = u.pathname.replace(/^\/api\/plugins\/worldscrawl/, '');
        if (route === '/prompts/active') return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ prompts }) };
        const r = server.request(opts.method || 'GET', route + u.search, { json: opts.body ? JSON.parse(opts.body) : undefined });
        return { ok: r.status_code < 400, status: r.status_code, headers: { get: k => r.headers.get(k) }, json: async () => r.json() };
    };
    ext.setPrompts(prompts);
    const worlds = server.get('/worlds').json();
    for (const w of worlds.worlds) w.start_date = { ...w.start_date, time };
    rememberWorlds(worlds);
    const c = SillyTavern.getContext(), id = `r5c${++n}`;
    c.chatId = id; c.getCurrentChatId = () => id; c.characterId = 0;
    c.chatMetadata = { worldscrawl_enabled: true };
    const rec = { calls: [], blocks: [], answers: {} };
    c.saveChat = async () => {}; c.saveSettingsDebounced = () => {}; c.updateMessageBlock = () => {}; c.addOneMessage = () => {};
    c.setExtensionPrompt = (key, text) => { if (String(text ?? '').trim()) rec.blocks.push({ key, text: String(text) }); };
    c.registerFunctionTool = () => {}; c.unregisterFunctionTool = () => {};
    c.generate = async () => {};
    c.executeSlashCommandsWithOptions = async () => {};
    c.generateRaw = async args => {
        const kind = callKind(args);
        rec.calls.push({ kind, prompt: String(args?.prompt ?? ''), sys: String(args?.systemPrompt ?? '') });
        const a = rec.answers[kind] ?? DEFAULT_ANSWERS[kind] ?? '{}';
        return typeof a === 'function' ? a(args) : Array.isArray(a) ? (a.length > 1 ? a.shift() : a[0]) : a;
    };
    globalThis.toastr = { info() {}, success() {}, warning() {}, error() {} };
    Object.assign(ext.settings(), { flagNpcs: true, flagTags: true, autoKeep: false, autoKeepWaits: true, moveMode: mode, trackerRetry: 'auto', narrateExpiries: true, ...settings });
    c.chat = [{ is_user: false, mes: 'A quiet morning in the common room.', swipe_id: 0, swipe_info: [{ extra: {} }], extra: { worldscrawl_world: { id: 'riverton', name: 'Riverton' }, worldscrawl_location: here } }, ...(chat ?? [])];
    return { c, rec };
}
const flush = (ms = 20) => new Promise(r => setTimeout(r, ms));
const say = (c, text, extra = {}) => { c.chat.push({ is_user: true, mes: text, swipe_id: 0, extra }); return c.chat.length - 1; };
const reply = (c, text) => { c.chat.push({ is_user: false, mes: text, swipe_id: 0, swipes: [text], swipe_info: [{ extra: {} }], extra: {} }); return c.chat.length - 1; };
async function intercept(c) {
    const core = c.chat.filter(m => !m.is_system).map(m => ({ ...m }));
    await globalThis.worldscrawlInterceptor(core, 0, () => {}, 'normal');
}
/** One player turn and the story's reply (the tracker reads it). */
async function turn(env, text, { answers = {}, story = 'The scene goes on.', mode = null } = {}) {
    const { c, rec } = env;
    Object.assign(rec.answers, answers);
    if (mode) ext.settings().moveMode = mode;
    say(c, text);
    await intercept(c);
    const at = reply(c, story);
    await onReplyForFlags(at); // what MESSAGE_RECEIVED runs: pasted tags, then the tracker
    await settle();
    for (const k of Object.keys(answers)) delete rec.answers[k];
}
/** Let the calls a turn started in the background (map changes, rebuilds, Remember, the schedule pick) finish. */
async function settle() { for (let i = 0; i < 100; i++) { await flush(10); if (!work.liveCalls().length) { await flush(10); if (!work.liveCalls().length) return; } } }
const H = () => N.handleOf('hesk');
// Answers a person pick with the handle listed for that name.
const pickName = name => () => N.handleOf(name === 'Bryn' ? 'bryn' : 'hesk');
/** A move stamp as movement.mjs writes it. */
const mv = (from, to, direction, from_name, to_name) => ({ seconds: 60, direction, from, from_name, to, to_name });
const tracker = o => JSON.stringify({ place: null, people: [], wait: null, ...o });
const patch = (id, at, ops, note, extra = {}) => ({ type: 'patch', id, at, ops, note, summary: [note], swipe: 0, ...extra });
const ai = (mes, extra = {}) => ({ is_user: false, mes, swipe_id: 0, swipes: [mes], swipe_info: [{ extra: {} }], extra });
const user = (mes, extra = {}) => ({ is_user: true, mes, swipe_id: 0, swipe_info: [{ extra: {} }], extra: { worldscrawl_intent_checked: true, ...extra } });
const STALL = (more = {}) => patch('stall', 0, [{ op: 'create_place', area: 'riverton:streets', id: 'stall', name: 'Pop-up Stall', description: 'Canvas and crates.', ...more,
    exits: [{ direction: 'stall', to: SQUARE, return_direction: 'square' }, { direction: 'lane', to: LANE, return_direction: 'stall' }] }], 'A stall goes up');
const COMMON_WAS = 'A low-beamed common room smelling of woodsmoke and spilled ale. A long oak bar runs along one wall, a fire crackles in a stone hearth, and a creaking staircase climbs to the rooms above.';
const SMOKE = 'Thick black smoke fills the low-beamed common room. A long oak bar runs along one wall, a fire crackles in a stone hearth, and a creaking staircase climbs to the rooms above.';
const SMOKE_BOARDS = 'Thick black smoke fills the low-beamed common room. A long oak bar runs along one wall, splintered floorboards lie by the hearth, and a creaking staircase climbs to the rooms above.';
const BOARDS = 'A low-beamed common room smelling of woodsmoke and spilled ale. A long oak bar runs along one wall, splintered floorboards lie by the hearth, and a creaking staircase climbs to the rooms above.';

/** The scripted pass. Returns every recorded call and narrator block. */
async function pass(prompts) {
    const all = { calls: [], blocks: [], marks: {} };
    const run = async (opts, steps) => {
        const env = boot(prompts, opts);
        await steps(env);
        all.calls.push(...env.rec.calls); all.blocks.push(...env.rec.blocks);
    };
    // Narrator: look, move, wait, sleep, find, not-found, doors.
    await run({}, async env => {
        await turn(env, 'I look around.');
        await turn(env, '[move] out');
        await turn(env, '[move] in');
        await turn(env, '[wait] 8h');
        await turn(env, '[sleep] 2h');
    });
    // Typed messages: the intent question and the pick-one questions behind it.
    await run({ mode: 'typed' }, async env => {
        await turn(env, 'I peer through the back door.', { answers: { intent: 'look', 'pick: look target': 'back', 'pick: closed door': 'listen' } });
        await turn(env, 'I look out of the window.', { answers: { intent: 'look', 'pick: look target': 'window' } });
        await turn(env, 'I open a door.', { answers: { intent: 'open a door', 'pick: door': 'back' } });
        await turn(env, 'I peek through the back door.', { answers: { intent: 'look', 'pick: look target': 'back', 'pick: closed door': 'peek' } });
        await turn(env, 'I look at the back door.', { answers: { intent: 'look', 'pick: look target': 'back', 'pick: closed door': 'look' } });
        await turn(env, 'I open the front door and look out.', { answers: { intent: 'look', 'pick: look target': 'out', 'pick: closed door': 'open' } });
        await turn(env, 'I smash through the east wall.', { answers: { intent: 'new opening', 'discovery / dig': '{"new": {"name": "Dusty Crawlspace", "description": "A cramped crawlspace full of cobwebs."}, "direction": "hole", "back": "out", "then": "stay"}' } });
        await turn(env, 'I want to be somewhere else.', { answers: { intent: 'zzz', 'intent: travel yes/no': 'no' } });
        await turn(env, 'I open a hidden door in the panelling.', { answers: { intent: 'try another door' } });
        await turn(env, 'I go out to the square.', { answers: { intent: 'out' } });
        await turn(env, 'I go back to the Common Room.', { answers: { intent: 'Common Room' } });
        await turn(env, 'I hack through the hedge and push on.', { answers: { intent: 'new opening', 'discovery / dig': '{"new": {"name": "Hedge Gap", "description": "A tunnel of torn branches."}, "direction": "gap", "back": "back", "then": "go_through"}' } });
        await turn(env, 'I smash my way out through the floor.', { answers: { intent: 'new opening', 'discovery / dig': '{}' } });
    });
    // Brackets: stuck doors, looks, a loose target, a loose wait, find, lore, travel.
    await run({}, async env => {
        await turn(env, '[open] back');
        await turn(env, '[move] back');
        await turn(env, '[look] back');
        await turn(env, '[look] up');
        await turn(env, '[move] somewhere quiet', { answers: { 'pick: bracket target': 'none' } });
        await turn(env, '[wait] a good long while', { answers: { 'wait amount': '{"seconds": 1800}' } });
        await turn(env, '[find] Bryn');
        await turn(env, '[lore] The Drowned Rat');
        for (const m of ['[move] out', '[move] south', '[move] north', '[move] in']) await turn(env, m);
        await turn(env, '[travel] River Docks');
    });
    await run({ here: YARD }, async env => {
        await turn(env, '[open] kitchen');
        await turn(env, '[close] kitchen');
        await turn(env, 'I listen at the kitchen door.', { mode: 'typed', answers: { intent: 'look', 'pick: look target': 'kitchen', 'pick: closed door': 'listen' } });
        await turn(env, '[open] kitchen', { mode: 'buttons' });
        await turn(env, 'I shut the kitchen door.', { mode: 'typed', answers: { intent: 'close a door', 'pick: door': 'kitchen' } });
        await turn(env, 'I open the kitchen door and look in.', { answers: { intent: 'look', 'pick: look target': 'kitchen', 'pick: closed door': 'open' } });
        await turn(env, 'I listen at the stable.', { answers: { intent: 'look', 'pick: look target': 'stable', 'pick: closed door': 'listen' } });
        await turn(env, 'I look at the stable.', { answers: { intent: 'look', 'pick: look target': 'stable', 'pick: closed door': 'look' } });
        await turn(env, 'I look out of the window.', { answers: { intent: 'look', 'pick: look target': 'window' } });
        await turn(env, '[look] trapdoor');
        await turn(env, '[look] stable');
    });
    // People and the map through the tracker: appearance (compose, looks summary), fact, memory, disposition, a place
    // change (scope, patch, rewrite) and a discovery; then the scope switches, the player's own field, a Retry of an
    // unreadable read, and a wait across the appearance's end (the person expiry lines, the tracker's "already done").
    await run({ settings: { autoKeep: true } }, async env => {
        const { c, rec } = env;
        await turn(env, 'I hand the landlady a towel.', { story: 'The landlady wrings out her soaked braids and smashes a mug on the bar.', answers: {
            tracker: tracker({ place: { changed: true, kind: 'change', note: 'the bar is smashed', rewrite: 'light', why: 'a mug smashed on it' },
                people: [{ id: H(), action: 'appearance', intent: 'braids soaked', fields: 'outfit', lasts: '1h', scope: 'light', why: 'rain' }, { id: H(), action: 'memory', text: 'The player gave her a towel.' },
                    { id: H(), action: 'fact', text: 'She hates the rain.' }, { id: H(), action: 'disposition', value: 'friendly', reason: 'a towel' }] }),
            'appearance compose': '{"outfit": "Widow\'s black, soaked through, and an apron."}', 'looks summary': '{"looks": "a big woman with soaked copper braids"}',
            'map edit: which rooms': `{"rooms": ["${TAVERN}"], "areas": []}`, 'map edit: the change': JSON.stringify({ ops: [{ op: 'set_description', loc: TAVERN, text: BOARDS }] }),
            'map edit: rewrite (full)': JSON.stringify({ ops: [{ op: 'set_description', loc: TAVERN, text: BOARDS }] }) } });
        // The place card's scope switch (a rewrite call) and the person card's (a compose call), through the card handlers.
        const fi = c.chat.findLastIndex(m => m.extra?.worldscrawl_flag);
        if (fi >= 0) { const msg = c.chat[fi], f = msg.extra.worldscrawl_flag; await cards.runCardAction('place', 'scope', { type: 'place', id: fi, msg, f, key: `${fi}|flag`, still: () => true }, { to: 'full' }); await settle(); }
        const own = c.chat.flatMap((m, i) => (m.extra?.[NPC_KEY] ?? []).map(s => ({ m, s, i }))).find(x => x.s.identity?.owner && x.s.candidate);
        if (own) {
            await cards.runCardAction('person', 'scope', { type: 'person', msg: own.m, s: own.s, who: 'the landlady', rev: own.s.decisionRev ?? 1, token: own.s.candidate?.token ?? null, identity: own.s.identity, key: `${own.s.identity.owner}|npcedit`, still: () => true }, { to: 'full' });
            await settle();
            await scene.settleNpc(c.chat, own.s.identity, own.s.decisionRev, 'edit', { intent: 'a clean apron', fields: 'outfit', scope: 'light', layer: { outfit: 'A clean white apron over widow\'s black.' }, elapsed: 0 });
            await settle();
            const now = (own.m.extra[NPC_KEY] ?? []).find(x => x.identity?.owner === own.s.identity.owner) ?? own.s;
            await cards.runCardAction('person', 'approve', { type: 'person', msg: own.m, s: now, who: 'the landlady', rev: now.decisionRev ?? 1, token: now.candidate?.token ?? null, identity: now.identity, key: `${now.identity.owner}|npcedit`, still: () => true });
            await settle();
        }
        // The map's In this chat edit: a new base text for her body (a baseline owner, composed), then a later light
        // change whose first answer drops too much of the base (the stricter retry line).
        const last = c.chat.length - 1;
        const r = await scene.npcChatEdit({ chatId: c.chatId, msg: last, swipe: c.chat[last].swipe_id ?? 0, id: 'hesk', stamps: [{ type: 'npc_baseline', field: 'body', text: 'Tall and raw-boned. A scar runs down one cheek.' }] });
        assert.ok(r.ok, JSON.stringify(r));
        await settle();
        const base = c.chat[last].extra[NPC_KEY].find(x => x.type === 'npc_baseline');
        assert.ok(base?.candidate, 'the baseline owner has a candidate');
        await scene.settleNpc(c.chat, base.identity, base.decisionRev, 'approve', { token: base.candidate.token, elapsed: 0 });
        await settle();
        await turn(env, 'I hand her a shawl.', { story: 'The landlady pulls a grey shawl over her apron.', answers: {
            tracker: () => tracker({ people: [{ id: H(), action: 'appearance', intent: 'a grey shawl', fields: 'outfit', lasts: '1h', scope: 'light', why: 'cold' }] }),
            'appearance compose': ['{"outfit": "A long red cloak and heavy riding boots."}', '{"outfit": "A clean white apron over widow\'s black, and a grey shawl."}'] } });
        await turn(env, 'I watch her knead dough.', { story: 'The landlady kneads dough; flour streaks her arms.', answers: {
            tracker: () => tracker({ people: [{ id: H(), action: 'appearance', intent: 'flour on her arms', fields: 'body', lasts: '1h', scope: 'light', why: 'kneading' }] }),
            'appearance compose': ['{"body": "A slight young man with a shaved head and a fresh tattoo."}', '{"body": "Tall and raw-boned, flour to the elbows. A scar runs down one cheek."}'] } });
        // Keep the shawl and the flour, then turn them off again: each field is rebuilt from the base with the changes
        // left, so the replaced base text (body) and her own written outfit (the edited apron) are listed again.
        const npcStamps = () => c.chat.flatMap(m => m.extra?.[NPC_KEY] ?? []);
        for (const intent of ['a grey shawl', 'flour on her arms']) {
            const st = npcStamps().find(x => x.identity?.owner && x.candidate?.intent === intent);
            assert.ok(st?.candidate, intent);
            await scene.settleNpc(c.chat, st.identity, st.decisionRev, 'approve', { token: st.candidate.token, elapsed: 0 });
            await settle();
            const now = npcStamps().find(x => x.identity?.owner === st.identity.owner);
            await scene.settleNpc(c.chat, now.identity, now.decisionRev, 'off', { elapsed: 0 });
            await settle();
        }
        await turn(env, 'I look behind the bar.', { story: 'Behind the bar, a narrow door you had not noticed stands ajar.', answers: {
            tracker: tracker({ place: { changed: true, kind: 'discover', note: 'a narrow door behind the bar' } }),
            'map edit: discovery': '{"name": "Back Office", "description": "A cramped office.", "direction": "narrow door", "return_direction": "out"}' } });
        const trackerCalls = () => env.rec.calls.filter(c => c.kind === 'tracker').length;
        const t0 = trackerCalls();
        await turn(env, 'I wait for her braids to dry.', { answers: { tracker: ['not json at all', tracker({})] } });
        all.marks.retryTurnTrackerCalls = trackerCalls() - t0; // the first answer is unreadable: asked once more on this turn
        await turn(env, '[wait] 2h');
        await turn(env, 'I talk to the landlady about the drunk.', { answers: { 'pick: who': pickName('the landlady') } });
        await turn(env, 'I ask Zqxhesk about her past, her secrets and her friends.');
    });
    // Remember (and again, with a hint), the schedule pick.
    await run({}, async env => {
        const { c } = env;
        const at = reply(c, 'Maren, the knife-grinder, works the wheel by the fire.');
        const REM = JSON.stringify({ name: 'Maren', personality: { summary: 'A knife-grinder.', manner: 'Watches hands.', speech: 'Quick.' }, appearance: { summary: 'wiry woman', body: 'Wiry.', outfit: 'A smock.' }, history: '', facts: ['sharpens knives'], memory: [] });
        Object.assign(env.rec.answers, { remember: REM, 'remember (prefetch)': REM,
            schedule: '{"pattern": "day_job", "job": "common_room", "home": "common_room"}' });
        await scene.offerRemember(c.chat[at], 'Maren');
        await settle();
        await scene.retryRemember(at, { hint: 'she grinds knives' });
        await settle();
    });
    // A timed place text that ran out under a later change: the rebuild call, and the narrator's "expired" line.
    await run({ chat: [user('I step into the inn.', { worldscrawl_move: mv(SQUARE, TAVERN, 'in', 'Village Square', 'Common Room') }),
        ai('A pot boils over and smoke pours out.', { worldscrawl_patches: [patch('p_smoke', 0, [{ op: 'set_description', loc: TAVERN, text: SMOKE, lasts: '1h' }], 'Smoke fills the common room')] }),
        ai('A barrel rolls and smashes the floorboards.', { worldscrawl_patches: [patch('p_boards', 600, [{ op: 'set_description', loc: TAVERN, text: SMOKE_BOARDS }], 'The floorboards by the hearth are splintered')] })] }, async env => {
        env.rec.answers['map rebuild'] = JSON.stringify({ text: BOARDS });
        await turn(env, '[wait] 2h');
    });
    // The party inside a stall that runs out: where they end up (the pick), narrated; then the same as a notice.
    for (const narrate of [true, false]) {
        await run({ here: SQUARE, settings: { narrateExpiries: narrate }, chat: [user('I step into the stall.', { worldscrawl_patches: [STALL({ lasts: '1h' })], worldscrawl_move: mv(SQUARE, BOOTH, 'into the stall', 'Village Square', 'Stall') }), ai('Canvas flaps around you.', { worldscrawl_location: BOOTH })] }, async env => {
            await turn(env, '[wait] 2h');
            await turn(env, 'I look around.');
        });
    }
    // A change turned off under the party (relocation without expiry), and around it (aftermath: gone, lost exits).
    await run({ here: SQUARE, chat: [user('A stall goes up.', { worldscrawl_patches: [STALL()], worldscrawl_move: mv(SQUARE, BOOTH, 'into the stall', 'Village Square', 'Stall') }), ai('You are in the stall.', { worldscrawl_location: BOOTH })] }, async env => {
        await toggleChange(1, 'stall'); await settle();
        await turn(env, 'I look around.');
    });
    await run({ here: SQUARE, chat: [user('A stall goes up.', { worldscrawl_patches: [STALL()] }), ai('You are in the square. A stall stands across the way.', { worldscrawl_location: SQUARE })] }, async env => {
        await toggleChange(1, 'stall'); await settle();
        await turn(env, 'I look around.');
    });
    // The tool mode's rules line; people who follow, wait, came along and are overdue; arrivals and departures in a wait.
    await run({ mode: 'tools' }, async env => { await turn(env, 'I look around.'); });
    const stamps = list => ({ worldscrawl_npc: list });
    await run({ chat: [user('Come with me, and you wait here.', stamps([{ type: 'npc_follow', id: 'hesk', who: 'player' }, { type: 'npc_stay', id: 'bryn', place: TAVERN }]))] }, async env => {
        await turn(env, 'I look around.');
        await turn(env, '[move] out');
    });
    await run({ chat: [user('Go with Bryn.', stamps([{ type: 'npc_follow', id: 'hesk', who: 'bryn' }]))] }, async env => { await turn(env, 'I look around.'); });
    await run({ time: '09:30' }, async env => {
        await turn(env, '[move] out', { story: 'The landlady steps out with you.', answers: { tracker: () => tracker({ people: [{ id: H(), action: 'came_along' }] }) } });
        await turn(env, 'I look around.', { story: 'The landlady stays at your side.', answers: { tracker: () => tracker({ people: [{ id: H(), action: 'came_along' }] }) } });
        await turn(env, '[wait] 3h');
    });
    await run({ time: '19:30' }, async env => {
        await turn(env, 'I talk to the landlady.', { answers: { 'pick: who': pickName('the landlady') } });
        await turn(env, '[wait] 40m');
        await turn(env, 'I keep talking to the landlady.', { answers: { 'pick: who': pickName('the landlady') } });
        await turn(env, '[wait] 1h');
    });
    await run({ time: '08:30' }, async env => { await turn(env, '[wait] 1h'); await turn(env, '[lore] The Drowned Rat'); });
    await run({ time: '22:30' }, async env => { await turn(env, '[wait] 1h'); });
    // Bryn's hour ends while he is held in the scene (moved on), or while he is with the player (along, due elsewhere).
    await run({ time: '22:40' }, async env => {
        await turn(env, 'I talk to Bryn.', { answers: { 'pick: who': pickName('Bryn') } });
        await turn(env, '[wait] 40m');
        await turn(env, 'I keep talking to Bryn.', { answers: { 'pick: who': pickName('Bryn') } });
    });
    await run({ time: '22:40' }, async env => {
        await turn(env, '[move] up', { story: 'Bryn follows you up the stairs.', answers: { tracker: () => tracker({ people: [{ id: N.handleOf('bryn'), action: 'came_along' }] }) } });
        await turn(env, '[wait] 40m');
        await turn(env, 'I look around.');
    });
    // Bryn passes through while the player waits (his might blocks): he comes and goes.
    await run({ time: '05:30', here: YARD }, async env => { await turn(env, '[wait] 4h'); });
    await run({ time: '22:30', here: SQUARE }, async env => { await turn(env, '[wait] 8h'); });
    await run({ time: '23:30', chat: [user('She knows my name.', stamps([{ type: 'npc_rel', id: 'hesk', who: 'player', state: 'named' }]))] }, async env => { await turn(env, '[find] Zqxhesk'); });
    await run({ time: '19:40' }, async env => {
        await turn(env, '[move] up', { story: 'The landlady follows you up the stairs.', answers: { tracker: () => tracker({ people: [{ id: H(), action: 'came_along' }] }) } });
        await turn(env, '[wait] 30m');
        await turn(env, 'I look around.');
    });
    await run({ time: '19:30' }, async env => { await turn(env, 'I sip my ale.'); await turn(env, '[wait] 1h'); await turn(env, 'I look around.'); });
    for (const here of [TAVERN, YARD]) await run({ time: '07:00', here }, async env => { await turn(env, '[find] Bryn'); });
    await run({}, async env => { await turn(env, 'I look around.', { story: 'Zqxhesk polishes a glass. [ws_flag: lore | Zqxhesk]' }); await turn(env, 'I talk to Zqxhesk.'); });
    await run({ time: '21:00' }, async env => { await turn(env, '[lore] The Drowned Rat'); await turn(env, '[find] the landlady'); });
    await run({ time: '23:30' }, async env => { await turn(env, '[lore] The Drowned Rat'); await turn(env, '[find] the landlady'); await turn(env, '[find] Bryn'); await turn(env, '[find] Zqxhesk'); });
    await run({ chat: [user('She knows my name.', stamps([{ type: 'npc_rel', id: 'hesk', who: 'player', state: 'named' }]))] }, async env => {
        await turn(env, 'I talk to the landlady.', { answers: { 'pick: who': pickName('the landlady') } });
        await turn(env, 'I talk to Bryn.', { answers: { 'pick: who': pickName('Bryn') } });
    });
    await run({ here: 'riverton:east_road/road' }, async env => { await turn(env, '[look] east'); });
    // Map changes the player and the narrator raise (no auto-keep): the scope by area, a patch retry, the full-rewrite
    // switch on the card; a discovery whose first answer is unreadable.
    await run({}, async env => {
        const { c, rec } = env;
        say(c, 'I set the kitchen on fire.'); const at = reply(c, 'Flames lick up the kitchen walls of The Drowned Rat.');
        Object.assign(rec.answers, { 'map edit: which rooms': '{"rooms": [], "areas": ["riverton:drowned_rat"]}',
            'map edit: the change': ['not a patch', JSON.stringify({ ops: [{ op: 'set_description', loc: TAVERN, text: BOARDS }] })],
            'map edit: rewrite (full)': JSON.stringify({ ops: [{ op: 'set_description', loc: TAVERN, text: SMOKE_BOARDS }] }),
            'map edit: discovery': ['not json', '{"name": "Root Cellar", "description": "A damp cellar.", "direction": "hatch", "return_direction": "up"}'] });
        await ext.flagMessage(at, { note: 'the kitchen burns', hint: 'The Drowned Rat', source: 'command' });
        await settle();
        const msg = c.chat[at], f = msg.extra.worldscrawl_flag;
        await cards.runCardAction('place', 'scope', { type: 'place', id: at, msg, f, key: `${at}|flag`, still: () => true }, { to: 'full' });
        await settle();
        say(c, 'I look around.'); const at2 = reply(c, 'Smoke curls under the door.');
        await ext.flagMessage(at2, { note: 'smoke under the door', source: 'tag' });
        await settle();
        say(c, 'I pull up a hatch.'); const at3 = reply(c, 'A hatch opens in the floor.');
        await ext.flagMessage(at3, { note: 'a hatch in the floor', source: 'command', kind: 'discover' });
        await settle();
    });
    // The room the narrator last saw is gone, the party already elsewhere (moved out, then the change turned off).
    await run({ here: SQUARE, chat: [user('A stall goes up.', { worldscrawl_patches: [STALL()], worldscrawl_move: mv(SQUARE, BOOTH, 'into the stall', 'Village Square', 'Stall') }), ai('You are in the stall.', { worldscrawl_location: BOOTH })] }, async env => {
        // The player walks on to Market Lane; no reply is written yet, so the last story is still the one told in the stall. Then
        // the stall is turned off: the party is not in it (no missing notice), and the narrator is told it is gone.
        say(env.c, '[move] lane');
        await intercept(env.c);
        await toggleChange(1, 'stall'); await settle();
        await intercept(env.c);
    });
    // The map window's Expand with AI: its prompt is built in the map window (placeform) and sent on the channel.
    await run({}, async env => {
        const gui = new Chan('worldscrawl');
        gui.postMessage({ type: 'expand', chatId: env.c.chatId, req: 1, prompt: placeform.expandPrompt({ region: { name: 'Riverton', lore: 'A river town.' }, neighbors: [{ name: 'Hall', short: 'Long.' }] }, { field: 'description', text: 'Dusty.', name: 'Attic', kind: 'room' }) });
        gui.postMessage({ type: 'expand', chatId: env.c.chatId, req: 2, prompt: placeform.expandPrompt({}, { field: 'lore', kind: 'subregion' }) });
        await settle();
    });
    return all;
}

const markersIn = t => [...String(t).matchAll(/⟦([a-z_.]+)⟧/g)].map(m => m[1]);
const reachedIn = got => new Set([...got.calls.flatMap(c => [...markersIn(c.prompt), ...markersIn(c.sys)]), ...got.blocks.flatMap(b => markersIn(b.text))]);

// Entries this pass does not reach, each with its reason. They
// are reached by narrower tests named here. The test fails if one of them is reached after all (the list must stay exact).
const ALLOW = {
    'narration.look_beyond_unseen': 'needs a peeked destination that is revealed but has no name, which the shipped worlds have none of; rendered in prompt-cases look.6',
    'narration.travel_cut_short': 'needs a multi-step [move] route that stops on the way (a closed door mid-path) in a world built for it; travel lines are in group1-commands',
    'npc.appearance_intent_written': 'listed only when a change with the player\'s own written text is composed again with a later one; a kept edit bakes into the base here. Through intentLine and the compose call in r3-compose A2',
    'npc.appearance_intent_replace': 'listed only when a replaced base text is composed again with a later change; kept baselines bake into the base here. Through intentLine in r3-compose A2',
};
// Not asserted by (a), reported instead: text that is data or answer keys, not prompt wording.
//  - OP_DOCS (the map-edit op list filled into {{edit_types}}), the pick/intent answer keys and option labels, and
//    pick.said's "The player wrote:" (R6) ride inside placeholder values; (a) sees only text outside every entry.
// The group 4 side calls (R5.4): the tracker retry, the own-field compose and the scope-switch rewrite are model calls too.
const KINDS_REQUIRED = ['intent', 'intent: travel yes/no', 'wait amount', 'tracker', 'schedule', 'map expand', 'map rebuild', 'appearance compose',
    'looks summary', 'remember (prefetch)', 'discovery / dig', 'pick: look target', 'pick: closed door', 'pick: view', 'pick: door', 'pick: bracket target',
    'pick: disposition', 'pick: who', 'pick: expiry', 'map edit: which rooms', 'map edit: the change', 'map edit: discovery', 'map edit: rewrite (full)'];

let passes = null;
const both = () => passes ??= (async () => ({ bare: await pass(markerPrompts(DEF)), keep: await pass(markerPrompts(DEF, { keepPlaceholders: true })), real: await pass(DEF) }))();
const left = t => String(t).replace(/⟦[a-z_.]+⟧/g, ' ');
const onlyPunct = t => /^[\s\p{P}\p{S}]*$/u.test(left(t));

test('R5.4 (a): with every entry a bare marker, each model call and narrator block has no text of its own', { timeout: 120000 }, async () => {
    const { bare } = await both();
    const kinds = new Set(bare.calls.map(c => c.kind));
    for (const k of KINDS_REQUIRED) assert.ok(kinds.has(k), `the pass makes a "${k}" call`);
    assert.ok(!kinds.has(''), 'every call is named by its kind');
    // The tracker retry: two tracker calls for one reply (the first answer unreadable).
    assert.equal(bare.marks.retryTurnTrackerCalls, 2, 'the retry turn itself asks the tracker twice');
    for (const c of bare.calls) {
        assert.ok(onlyPunct(c.sys), `${c.kind} (system): ${JSON.stringify(left(c.sys).trim()).slice(0, 200)}`);
        assert.ok(onlyPunct(c.prompt), `${c.kind}: ${JSON.stringify(left(c.prompt).trim()).slice(0, 200)}`);
    }
    assert.ok(bare.blocks.length > 50);
    for (const b of bare.blocks) assert.ok(onlyPunct(b.text), `narrator ${b.key}: ${JSON.stringify(left(b.text).trim()).slice(0, 200)}`);
});

test('R5.4 (b): every prompt id is reached by some call or narrator block, or is on the allowlist with its reason', { timeout: 120000 }, async () => {
    const { keep } = await both();
    const reached = reachedIn(keep);
    const ids = DEF.prompts.map(e => e.id);
    for (const id of Object.keys(ALLOW)) assert.ok(ids.includes(id), `allowlisted ${id} is an entry`);
    assert.deepEqual(ids.filter(id => !reached.has(id) && !ALLOW[id]), [], 'unreached ids');
    assert.deepEqual(Object.keys(ALLOW).filter(id => reached.has(id)), [], 'allowlisted ids that are reached after all');
});

test('R5.1: every narration.* entry the narrator gets comes from its entry (marker override through applyFacts)', { timeout: 120000 }, async () => {
    const { keep } = await both();
    const inBlocks = new Set(keep.blocks.flatMap(b => markersIn(b.text)));
    // narration.expiry_pick is the expiry pick's own question (a side call), not narrator text.
    const narration = DEF.prompts.map(e => e.id).filter(id => id.startsWith('narration.') && !ALLOW[id] && id !== 'narration.expiry_pick');
    assert.deepEqual(narration.filter(id => !inBlocks.has(id)), []);
});

test('R5.2 (N1): one-time lines come before stay-put, and the rules line is last, on every narrator turn', { timeout: 120000 }, async () => {
    const { bare } = await both();
    const ONCE = ['narration.waited', 'narration.slept', 'narration.wait_weather', 'narration.wait_wore_off', 'narration.expired', 'narration.aftermath_gone', 'narration.relocated_gone', 'narration.relocated_missing', 'narration.aftermath_lost_exits', 'narration.person_wore_off'];
    let rules = 0, tools = 0;
    const seen = new Set();
    for (const b of bare.blocks) {
        const m = markersIn(b.text);
        const last = m.filter(id => id === 'narration.rules' || id === 'narration.rules_tools');
        if (last.length) { rules++; if (last[0] === 'narration.rules_tools') tools++; assert.equal(last.length, 1); assert.equal(m.at(-1), last[0], `rules last: ${m.join(' ')}`); }
        const sp = m.indexOf('narration.stay_put');
        for (const id of ONCE) if (m.includes(id)) { seen.add(id); if (sp >= 0) assert.ok(m.indexOf(id) < sp, `${id} before stay_put: ${m.join(' ')}`); }
    }
    assert.ok(rules > 50, `${rules} rules lines`);
    assert.ok(tools >= 1, 'the tools-mode turn (rules_tools) is covered');
    if (DUMP) console.log('ONCE seen', [...seen].join(' '));
    assert.deepEqual(ONCE.filter(id => !seen.has(id)), [], 'every one-time line is checked on some turn');
});

test('R5.3 / R5.3b (N5, N4): with the shipped prompts, the narrator gets durations in words and no handles; the tracker and the who pick keep theirs', { timeout: 120000 }, async () => {
    const { real } = await both();
    // Queued (not R5): the server's `ended` note for a timed change, "X expired at <date> (lasted 1h, from message #1)",
    // reaches narration.expired as a value; it is taken out here and reported.
    const narrator = real.blocks.map(b => b.text).join('\n').replace(/expired at [^()]*\([a-z]+\)? ?\(lasted [^)]*\)/g, '');
    assert.deepEqual(narrator.match(/.{0,80}(\b\d+h\d*m?\b|\b\d+m\b).{0,40}/g) ?? [], [], 'no 2h / 40m');
    assert.doesNotMatch(narrator, /\[p[0-9a-z]{4}\]/, 'no [pxxxx] handles');
    assert.doesNotMatch(narrator, /(?<!\bif )you can see/i);
    assert.match(narrator, /\b(an hour|40 minutes|2 hours|3 hours|8 hours)\b/, 'waits in words');
    const tracker = real.calls.filter(c => c.kind === 'tracker' && /\bp[0-9a-z]{4}\b/.test(c.prompt));
    assert.ok(tracker.length, 'the tracker lists people by handle');
    assert.ok(real.calls.some(c => c.kind === 'pick: who' && /^- p[0-9a-z]{4}: /m.test(c.prompt)), 'the who pick lists handles');
});

test('R5.4 dump', { skip: !DUMP }, async () => {
    const { keep, bare } = await both();
    console.log('KINDS', [...new Set(keep.calls.map(c => c.kind))].join(' | '));
    const reached = reachedIn(keep);
    console.log('UNREACHED', DEF.prompts.map(e => e.id).filter(id => !reached.has(id)).join(' '));
    for (const c of bare.calls) console.log('CALL', c.kind, JSON.stringify(c.sys).slice(0, 200), '||', JSON.stringify(c.prompt).slice(0, 400));
    for (const b of bare.blocks) console.log('BLOCK', b.key, JSON.stringify(b.text).slice(0, 600));
});
