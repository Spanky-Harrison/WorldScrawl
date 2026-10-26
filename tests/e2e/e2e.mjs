import { chromium } from 'playwright-core';
const BASE = 'http://localhost:8767/';
const FAKE = 'http://127.0.0.1:9098';
let failures = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}: ${name} ${extra}`); if (!ok) failures++; };
const queue = q => fetch(`${FAKE}/__queue`, { method: 'POST', body: JSON.stringify(q) });

const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'], headless: true });
try {
    const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
    page.on('console', m => { if (m.type() === 'error' || /WorldScrawl/.test(m.text())) console.log('[console]', m.type(), m.text().slice(0, 300)); });
    const apiCalls = [];
    const apiUrls = [];
    const typedGets = []; // GETs to the map server that carry a Content-Type (would force a CORS preflight)
    const API = '/api/plugins/worldscrawl';
    // The test's own direct calls to the map server (stFetch) are not the extension's and are not recorded.
    page.on('request', r => { const u = r.url(); if (!u.includes(API + '/') || r.headers()['x-e2e-direct']) return; apiCalls.push(decodeURIComponent(new URL(u).pathname.slice(API.length))); apiUrls.push(u); if (r.method() === 'GET' && r.headers()['content-type']) typedGets.push(u); });
    /** Call the map server plugin the way the extension does: same origin, with SillyTavern's CSRF token. */
    const stFetch = async (path, opts = {}) => {
        const r = await page.evaluate(async ([url, o]) => {
            const h = { ...SillyTavern.getContext().getRequestHeaders(), ...(o.headers ?? {}), 'X-E2E-Direct': '1' };
            if (!o.body) delete h['Content-Type'];
            const res = await fetch(url, { ...o, headers: h });
            return { status: res.status, ok: res.ok, text: await res.text() };
        }, [API + path, opts]);
        return { ...r, json: async () => JSON.parse(r.text) };
    };
    page.on('pageerror', e => console.log('[pageerror]', e.message));
    await page.goto(BASE);
    await page.waitForSelector('#send_textarea', { timeout: 90000 });
    const ok = page.locator('dialog[open] .popup-button-ok').first();
    try { await ok.waitFor({ timeout: 8000 }); await ok.click(); } catch {}
    await page.waitForTimeout(1500);

    await page.waitForSelector('input[name="worldscrawl_mode"]', { state: 'attached', timeout: 60000 });
    check('Enable in new chats is off by default', await page.evaluate(() => SillyTavern.getContext().extensionSettings.worldscrawl.enableNewChats === false && !document.getElementById('worldscrawl_enable_new').checked));
    await page.evaluate(() => { const b = document.getElementById('worldscrawl_enable_new'); b.checked = true; b.dispatchEvent(new Event('change')); }); // the rest of the run uses WorldScrawl chats
    const toolNames = () => page.evaluate(() => SillyTavern.getContext().ToolManager.tools.map(t => t.toFunctionOpenAI().function.name));
    check('tools off by default', !(await toolNames()).includes('ws_move'));
    check('no tool nudge by default', await page.evaluate(() => !SillyTavern.getContext().extensionPrompts?.worldscrawl_nudge?.value));
    check('default mode is typed moves', await page.evaluate(() => document.querySelector('input[name="worldscrawl_mode"]:checked')?.value === 'typed'));
    check('old checkboxes gone', await page.locator('#worldscrawl_use_tools, #worldscrawl_parse_intent').count() === 0);
    const mig = await page.evaluate(async () => {
        const m = await import('/scripts/extensions/third-party/WorldScrawl/index.js');
        const es = SillyTavern.getContext().extensionSettings; const keep = es.worldscrawl; const out = [];
        for (const old of [{ parseIntent: false, useTools: false }, { parseIntent: true, useTools: true }, { parseIntent: true, useTools: false }, {}]) {
            es.worldscrawl = { serverUrl: keep.serverUrl, ...old }; const s = m.settings(); out.push(s.moveMode + (('useTools' in s || 'parseIntent' in s) ? '!' : ''));
        }
        es.worldscrawl = keep;
        const p = m.parseIntentAnswer;
        out.push(p('<think>they want to leave</think>\nOut.', ['out', 'up']), p('Answer: Elsewhere', ['out']), p('STAY', ['out']), p('the temple', ['out']), p('<think>unfinished', ['out']));
        out.push(m.parseYesNo('<think>hmm</think>\nYes.'), m.parseYesNo('maybe'));
        const g = { a: ['b'], b: ['a', 'c'], c: ['b'] };
        const getLoc = async x => ({ exits: g[x.split(':')[1]].map(t => ({ direction: 'to_' + t, to: 'r:' + t })) });
        out.push(JSON.stringify(await m.findPath('r:a', 'r:c', getLoc)));
        // Routing limits: intermediates must be stood in; hidden exits never used.
        const G = { a: [['east', 'b'], ['south', 'd'], ['secret', 'c', true]], b: [['east', 'c']], d: [['east', 'e']], e: [['north', 'c']], c: [] };
        const gl = async x => ({ exits: G[x.split(':')[1]].map(([direction, t, hidden]) => ({ direction, to: 'r:' + t, hidden: !!hidden })) });
        const path = async (vis) => JSON.stringify((await m.findPath('r:a', 'r:c', gl, new Set(vis.map(v => 'r:' + v))))?.map(x => x.direction) ?? null);
        window.__routeTests = [await path(['a']), await path(['a', 'd', 'e']), await path(['a', 'b']), await path(['a', 'b', 'd', 'e'])];
        const hid = { exits: [{ direction: 'north', to_name: 'Secret Vault', hidden: true }, { direction: 'out', to_name: 'Village Square' }] };
        out.push(m.exitsText(hid), m.exitLabel(hid.exits[0]), m.revealsDestination(hid.exits[1]));
        return out;
    });
    check('old checkbox settings migrate to radio', JSON.stringify(mig.slice(0, 4)) === '["commands","tools","typed","typed"]', JSON.stringify(mig));
    check('answer parsing (think tags, prefixes, exact match)', JSON.stringify(mig.slice(4)) === '["out","elsewhere","stay",null,null,"yes",null,"[{\\"direction\\":\\"to_b\\",\\"to\\":\\"r:b\\"},{\\"direction\\":\\"to_c\\",\\"to\\":\\"r:c\\"}]","Exits: north, out (Village Square)","north",true]', JSON.stringify(mig.slice(4)));
    const rt = await page.evaluate(() => window.__routeTests);
    check('route refused when shortest path needs an unvisited room', rt[0] === 'null', JSON.stringify(rt));
    check('route goes the long way via visited rooms only', rt[1] === '["south","east","north"]', JSON.stringify(rt));
    check('hidden exit never used for routing', rt[2] === '["east","east"]' && rt[3] === '["east","east"]', JSON.stringify(rt));
    check('slash commands registered', await page.evaluate(() => { const p = SillyTavern.getContext().SlashCommandParser.commands; return !!p['ws-go'] && !!p['ws-exits']; }));
    // Part 1: the optional tool mode still works.
    await page.evaluate(() => { const r = document.querySelector('input[name="worldscrawl_mode"][value="tools"]'); r.checked = true; r.dispatchEvent(new Event('change')); });
    const tools = await page.evaluate(() => SillyTavern.getContext().ToolManager.tools.map(t => t.toFunctionOpenAI().function.name));
    check('tools registered', tools.includes('ws_look') && tools.includes('ws_move'), JSON.stringify(tools));
    check('settings panel present', await page.locator('#worldscrawl_url').count() === 1);
    check('tool instructions injected', await page.evaluate(() => /call ws_look/.test(SillyTavern.getContext().extensionPrompts?.worldscrawl_nudge?.value ?? '')));

    // Point the extension at the test server and connect ST to the fake model with function calling on.
    await page.evaluate(() => { const c = SillyTavern.getContext(); c.extensionSettings.worldscrawl.serverUrl = ''; });
    await page.evaluate(async () => {
        const $ = window.jQuery;
        $('#main_api').val('openai').trigger('change');
        $('#chat_completion_source').val('custom').trigger('change');
        $('#custom_api_url_text').val('http://127.0.0.1:9098/v1').trigger('input');
        $('#custom_model_id').val('fake-model').trigger('input');
        $('#stream_toggle').prop('checked', false).trigger('input');
        $('#openai_function_calling').prop('checked', true).trigger('input');
    });
    await page.evaluate(() => jQuery('#api_button_openai').trigger('click'));
    await page.waitForTimeout(3000);
    await page.evaluate(async () => { const o = await import('/scripts/openai.js'); o.oai_settings.stream_openai = false; });
    check('tool calling supported', await page.evaluate(() => SillyTavern.getContext().isToolCallingSupported()));

    // Open a chat with the bundled default character.
    await page.evaluate(async () => { const c = SillyTavern.getContext(); await c.selectCharacterById(0); });
    await page.waitForTimeout(2500);
    await page.evaluate(() => jQuery('#worldscrawl_test').trigger('click'));
    await page.waitForTimeout(1000);
    const status = await page.textContent('#worldscrawl_status');
    check('Test connection button', status.startsWith('Connected'), status);

    let expected = 0;
    const send = async (text, n = 2) => {
        expected += n;
        const dlg = page.locator('dialog[open]');
        if (await dlg.count()) { console.log('[dialog]', (await dlg.first().textContent()).trim().slice(0, 200)); await page.keyboard.press('Escape'); await page.waitForTimeout(500); }
        await page.fill('#send_textarea', text);
        await page.click('#send_but');
        for (let i = 0; i < 60; i++) { const r = await (await fetch(`${FAKE}/__requests`)).json(); if (r.length >= expected) break; if (i === 59) { console.log(`[send] gave up: ${r.length} model requests, expected ${expected}`); } await page.waitForTimeout(500); }
        await page.waitForFunction(() => !jQuery('#mes_stop').is(':visible'), null, { timeout: 30000 });
        await page.waitForTimeout(2000);
    };
    const stored = () => page.evaluate(() => { const ch = SillyTavern.getContext().chat; for (let i = ch.length - 1; i >= 0; i--) if (ch[i]?.extra?.worldscrawl_location) return ch[i].extra.worldscrawl_location; return null; });

    await queue([{ tool_calls: [{ name: 'ws_look' }] }, { content: 'You are in the tavern.' }]);
    await send('Where am I?');
    check('look stamps start location', (await stored()) === 'riverton:drowned_rat/common_room', String(await stored()));

    await queue([{ tool_calls: [{ name: 'ws_move', arguments: { direction: 'out' } }] }, { content: 'You step into the square.' }]);
    await send('I go outside.');
    check('move out -> square', (await stored()) === 'riverton:streets/square', String(await stored()));
    const reqs = await (await fetch(`${FAKE}/__requests`)).json();
    const last = JSON.stringify(reqs[reqs.length - 1].messages);
    const footer = () => page.evaluate(() => { const els = [...document.querySelectorAll('#chat .mes')]; return els[els.length - 1]?.querySelector('.worldscrawl_exits')?.textContent ?? null; });
    const f1 = await footer();
    check('exits footer shown under reply', /^Exits: .*\(/.test(f1 ?? '') && f1.includes('north'), String(f1));
    check('footer not in message text', await page.evaluate(() => !SillyTavern.getContext().chat.some(m => /Exits:/.test(m.mes ?? ''))));
    await page.evaluate(() => { const c = document.getElementById('worldscrawl_show_exits'); c.checked = false; c.dispatchEvent(new Event('change')); });
    check('footer toggles off', await page.locator('#chat .worldscrawl_exits').count() === 0);
    await page.evaluate(() => { const c = document.getElementById('worldscrawl_show_exits'); c.checked = true; c.dispatchEvent(new Event('change')); });
    await page.waitForTimeout(1000);
    check('footer toggles back on', await page.locator('#chat .worldscrawl_exits').count() > 0);
    check('model got the new location in the tool result', last.includes('Village Square'));
    check('tools sent to model', JSON.stringify(reqs[0].tools ?? []).includes('ws_move'));

    await queue([{ tool_calls: [{ name: 'ws_move', arguments: { direction: 'sideways' } }] }, { content: 'You cannot go that way.' }]);
    await send('I go sideways.');
    check('bad move keeps location', (await stored()) === 'riverton:streets/square');
    const reqs2 = await (await fetch(`${FAKE}/__requests`)).json();
    check('bad move returns valid directions', JSON.stringify(reqs2[reqs2.length - 1].messages).includes('valid_directions'));

    await queue([{ tool_calls: [{ name: 'ws_move', arguments: { direction: 'north' } }] }, { content: 'The temple.' }]);
    await send('Up to the temple.');
    check('move north -> temple', (await stored()) === 'riverton:temple/nave');

    // Deleting the last exchange (user msg, tool record, reply) rolls the location back.
    await page.evaluate(async () => { const c = SillyTavern.getContext(); await c.executeSlashCommandsWithOptions('/del 3'); });
    await page.waitForTimeout(1500);
    check('deleting messages rolls location back', (await stored()) === 'riverton:streets/square', String(await stored()));

    // Survives reload (saved with the chat).
    await page.reload(); await page.waitForSelector('#send_textarea', { timeout: 60000 }); await page.waitForTimeout(3000);
    await page.evaluate(async () => { await SillyTavern.getContext().selectCharacterById(0); });
    await page.waitForTimeout(3000);
    check('location persisted with chat', (await stored()) === 'riverton:streets/square', String(await stored()));
    check('footer re-rendered on chat load', ((await footer()) ?? '').startsWith('Exits:'), String(await footer()));
    const reqs3 = await (await fetch(`${FAKE}/__requests`)).json();
    check('footer never sent to model', !reqs3.some(r => JSON.stringify(r.messages).includes('Exits: ')));
    check('facts injected (tool mode)', reqs3.some(r => JSON.stringify(r.messages).includes('World state from the game engine')));

    // Part 2: engine-driven movement (default mode). Location is riverton:streets/square here.
    await page.evaluate(() => { const r = document.querySelector('input[name="worldscrawl_mode"][value="typed"]'); r.checked = true; r.dispatchEvent(new Event('change')); });
    await page.waitForTimeout(500);
    check('tools unregistered when off', !(await toolNames()).includes('ws_move'));
    const lastReq = async () => { const r = await (await fetch(`${FAKE}/__requests`)).json(); return r[r.length - 1]; };
    const waitReqs = async () => { for (let i = 0; i < 60; i++) { const r = await (await fetch(`${FAKE}/__requests`)).json(); if (r.length >= expected) break; if (i === 59) { console.log(`[wait] gave up: ${r.length} model requests, expected ${expected}`); } await page.waitForTimeout(500); } await page.waitForFunction(() => !jQuery('#mes_stop').is(':visible'), null, { timeout: 30000 }); await page.waitForTimeout(2000); };

    // The reload above dropped the API connection; reconnect.
    await page.evaluate(() => jQuery('#api_button_openai').trigger('click'));
    await page.waitForTimeout(3000);
    await page.evaluate(async () => { const o = await import('/scripts/openai.js'); o.oai_settings.stream_openai = false; });
    // Typed movement: intent question answered "south" -> engine moves to the docks.
    await queue([{ content: ' South.' }, { content: 'You walk down to the docks.' }]);
    await send('Let us head down to the river.', 2);
    let all = await (await fetch(`${FAKE}/__requests`)).json();
    const intentReq = JSON.stringify(all[all.length - 2].messages);
    check('intent question asked with exit list', /Which option: in, south, north, east, west, [^?]*stay, elsewhere, unclear\?/.test(intentReq), intentReq.slice(0, 200));
    check('intent request has no tools', !JSON.stringify(all[all.length - 2].tools ?? []).includes('ws_move'));
    check('intent marks where you came from', intentReq.includes('in (to The Drowned Rat, where you came from)'), intentReq.slice(0, 400));
    check('typed movement moved party', (await stored()) === 'riverton:docks/piers', String(await stored()));
    let narr = JSON.stringify((await lastReq()).messages);
    check('narration got arrival facts', narr.includes('User moved south from Village Square (Riverton Streets) to River Docks') && narr.includes('never move User'), '');
    check('narration request has no tools', !JSON.stringify((await lastReq()).tools ?? []).includes('ws_move'));
    check('no nudge when tools off', !narr.includes('call ws_look'));

    // Typed non-movement: "none" -> no move, no arrival line.
    await queue([{ content: 'stay' }, { content: 'You look at the boats.' }]);
    await send('I look at the boats.', 2);
    check('non-movement keeps location', (await stored()) === 'riverton:docks/piers');
    narr = JSON.stringify((await lastReq()).messages);
    check('no arrival line without a move', !narr.includes('What just happened') && narr.includes('Current location: River Docks') && narr.includes('User has NOT moved this turn and is still at River Docks'));

    // Invalid answer (not on the list) is treated as none.
    await queue([{ content: 'I think they go to the temple' }, { content: 'no' }, { content: 'Hmm.' }]);
    await send('Maybe the temple?', 3);
    check('non-list answer = no move', (await stored()) === 'riverton:docks/piers');

    // Clicking an exit in the footer of the latest reply.
    check('only latest footer has buttons', await page.evaluate(() => { const f = [...document.querySelectorAll('#chat .worldscrawl_exits')]; return f.length > 1 && f.slice(0, -1).every(x => !x.querySelector('.worldscrawl_exit')) && !!f[f.length - 1].querySelector('.worldscrawl_exit'); }));
    await queue([{ content: 'Back in the square.' }]);
    expected += 1;
    await page.click('#chat .mes:last-child .worldscrawl_exit[data-direction="north"]');
    await waitReqs();
    check('click moves party', (await stored()) === 'riverton:streets/square', String(await stored()));
    check('click adds party note', await page.evaluate(() => SillyTavern.getContext().chat.some(m => m.is_user && m.mes === '*User goes north.*')));
    narr = JSON.stringify((await lastReq()).messages);
    check('click narration has arrival facts', narr.includes('User moved north from River Docks to Village Square (Riverton Streets)'));
    check('click did not ask intent', (await (await fetch(`${FAKE}/__requests`)).json()).length === expected);

    // /ws-go and /ws-exits.
    await queue([{ content: 'The temple.' }]);
    expected += 1;
    await page.evaluate(() => SillyTavern.getContext().executeSlashCommandsWithOptions('/ws-go North'));
    await waitReqs();
    check('/ws-go moves party', (await stored()) === 'riverton:temple/nave', String(await stored()));
    narr = JSON.stringify((await lastReq()).messages);
    check('notes: temple drops region notes (inherit_notes false)', narr.includes('About Temple of the Tides: A hushed') && !narr.includes('About Riverton:'), narr.slice(0, 300));
    const ex = await page.evaluate(async () => (await SillyTavern.getContext().executeSlashCommandsWithOptions('/ws-exits')).pipe);
    check('/ws-exits lists exits', ex === 'Exits: south (Village Square), grate', String(ex));
    const before = (await (await fetch(`${FAKE}/__requests`)).json()).length;
    await page.evaluate(() => SillyTavern.getContext().executeSlashCommandsWithOptions('/ws-go sideways'));
    await page.waitForTimeout(1500);
    check('/ws-go bad direction: no move, no generation', (await stored()) === 'riverton:temple/nave' && (await (await fetch(`${FAKE}/__requests`)).json()).length === before);
    check('/ws-go unknown name: not-aware message', await page.evaluate(() => { const ch = SillyTavern.getContext().chat; const m = ch[ch.length - 1]; return m.is_system && m.mes === "You're not aware of such a place. Exits: south (Village Square), grate"; }));
    check('engine footer never in message text', await page.evaluate(() => !SillyTavern.getContext().chat.some(m => !m.extra?.worldscrawl_notice && /Exits:/.test(m.mes ?? ''))));

    // Intent setting off: no question asked.
    await page.evaluate(() => { const r = document.querySelector('input[name="worldscrawl_mode"][value="commands"]'); r.checked = true; r.dispatchEvent(new Event('change')); });
    await queue([{ content: 'You stay.' }]);
    await send('I go south.', 1);
    check('clicks-and-commands mode: no move, single request', (await stored()) === 'riverton:temple/nave' && !JSON.stringify((await lastReq()).messages).includes('Which option'));

    // Temple from the tavern (not adjacent): blocked with a game message, no narration call.
    await page.evaluate(() => { const r = document.querySelector('input[name="worldscrawl_mode"][value="typed"]'); r.checked = true; r.dispatchEvent(new Event('change')); });
    await queue([{ content: 'Square.' }, { content: 'Tavern.' }]); expected += 1;
    await page.evaluate(() => SillyTavern.getContext().executeSlashCommandsWithOptions('/ws-go south')); await waitReqs(); expected += 1;
    await page.evaluate(() => SillyTavern.getContext().executeSlashCommandsWithOptions('/ws-go in')); await waitReqs();
    check('back in the tavern', (await stored()) === 'riverton:drowned_rat/common_room', String(await stored()));
    const lastMsg = () => page.evaluate(() => { const ch = SillyTavern.getContext().chat; const m = ch[ch.length - 1], u = ch[ch.length - 2]; return { mes: m.mes, sys: !!m.is_system, prev: u.mes, prevUser: !!u.is_user }; });
    await queue([{ content: 'elsewhere' }]);
    await send('go to the castle', 1);
    let lm = await lastMsg();
    check('unreachable: location unchanged', (await stored()) === 'riverton:drowned_rat/common_room');
    check('unreachable: game message shown', lm.sys && lm.mes === "You're not aware of such a place. Exits: out (Village Square), up (Upstairs Rooms), back (Courtyard)", JSON.stringify(lm));
    check('unreachable: user message kept', lm.prevUser && lm.prev === 'go to the castle');
    check('unreachable: no narration call', (await (await fetch(`${FAKE}/__requests`)).json()).length === expected && JSON.stringify((await lastReq()).messages).includes('Which option'));
    const noticeBtns = () => page.evaluate(() => { const els = [...document.querySelectorAll('#chat .mes')]; return els.filter(e => /not aware of such a place|know a way to/.test(e.textContent)).map(e => [...e.querySelectorAll('.worldscrawl_exit')].map(b => b.textContent)); });
    check('game message exits are buttons', JSON.stringify((await noticeBtns()).pop()) === '["out (Village Square)","up (Upstairs Rooms)","back (Courtyard)"]', JSON.stringify(await noticeBtns()));
    check('game message visible in chat', await page.evaluate(() => [...document.querySelectorAll('#chat .mes')].some(e => /not aware of such a place|know a way to/.test(e.textContent))));

    // Unparseable answer on a travel-looking message fails closed.
    await queue([{ content: '<think>hmm, the castle?</think>I am not sure' }, { content: 'Yes' }]);
    await send('I walk to the castle', 2);
    lm = await lastMsg();
    check('garbled answer + yes follow-up: blocked', lm.sys && /not aware of such a place/.test(lm.mes) && (await stored()) === 'riverton:drowned_rat/common_room', JSON.stringify(lm));
    check('follow-up question asked', JSON.stringify((await lastReq()).messages).includes('Is the player trying to travel to a different place? Answer yes or no.'));

    let nb = await noticeBtns();
    check('only latest game message clickable', nb.length >= 2 && nb.slice(0, -1).every(x => x.length === 0) && nb[nb.length - 1].length === 3, JSON.stringify(nb));
    // Survives a reload (rebuilt from stored data).
    await page.reload(); await page.waitForSelector('#send_textarea', { timeout: 60000 }); await page.waitForTimeout(3000);
    await page.evaluate(async () => { await SillyTavern.getContext().selectCharacterById(0); });
    await page.waitForTimeout(3000);
    nb = await noticeBtns();
    check('game message buttons survive reload', nb.length >= 2 && nb[nb.length - 1].length === 3, JSON.stringify(nb));
    await page.evaluate(() => jQuery('#api_button_openai').trigger('click'));
    await page.waitForTimeout(3000);
    await page.evaluate(async () => { const o = await import('/scripts/openai.js'); o.oai_settings.stream_openai = false; });
    // Clicking an exit in the game message moves the party.
    await queue([{ content: 'Upstairs.' }]); expected += 1;
    await page.click('#chat .mes:last-child .worldscrawl_exit[data-direction="up"]');
    await waitReqs();
    check('game message button moves party', (await stored()) === 'riverton:drowned_rat/upstairs', String(await stored()));
    narr = JSON.stringify((await lastReq()).messages);
    check('notes: quiet upstairs keeps region notes, drops tavern notes (location override)', narr.includes('About Riverton: Riverton is a small') && !narr.includes("Riverton's oldest tavern") && narr.includes('the location description wins'));
    await queue([{ content: 'Down again.' }]); expected += 1;
    await page.evaluate(() => SillyTavern.getContext().executeSlashCommandsWithOptions('/ws-go down')); await waitReqs();

    // Garbled answer on a non-travel message ("run my hand" would have tripped the old keyword list): normal reply.
    await queue([{ content: 'blorp' }, { content: 'no' }, { content: 'The wood is smooth.' }]);
    await send('I run my hand along the bar', 3);
    lm = await lastMsg();
    narr = JSON.stringify((await lastReq()).messages);
    check('bar: normal reply, no game message', !lm.sys && lm.mes === 'The wood is smooth.' && (await stored()) === 'riverton:drowned_rat/common_room', JSON.stringify(lm));
    check('bar: not-moved injection', narr.includes('User has NOT moved this turn and is still at Common Room (The Drowned Rat)'));

    // Think tags stripped before matching; a real move still works, and the game messages never reach the model.
    await queue([{ content: '<think>they want to go outside</think>\nOut' }, { content: 'The square.' }]);
    await send('step outside', 2);
    check('think-tag answer moves party', (await stored()) === 'riverton:streets/square', String(await stored()));
    const allReqs = await (await fetch(`${FAKE}/__requests`)).json();
    check('game messages never sent to model', !allReqs.some(r => JSON.stringify(r.messages).includes("not aware of such a place") || JSON.stringify(r.messages).includes("know a way to")));

    // Route-finding to a visited place: tavern -> square -> temple.
    await queue([{ content: 'Tavern.' }]); expected += 1;
    await page.evaluate(() => SillyTavern.getContext().executeSlashCommandsWithOptions('/ws-go in')); await waitReqs();
    await queue([{ content: 'Temple of the Tides' }, { content: 'A walk up the hill.' }]);
    await send('go to the temple', 2);
    const routeQ = JSON.stringify(all = (await (await fetch(`${FAKE}/__requests`)).json()), null, 0);
    check('visited place offered as option', /Which option: out, up, back, [^?]*Temple of the Tides[^?]*, stay, elsewhere, unclear\?/.test(JSON.stringify(all[all.length - 2].messages)), JSON.stringify(all[all.length - 2].messages).slice(-200));
    check('route: arrived at temple', (await stored()) === 'riverton:temple/nave', String(await stored()));
    check('route: journey facts', JSON.stringify((await lastReq()).messages).includes('User travelled from Common Room (The Drowned Rat) through Village Square (Riverton Streets) to Temple of the Tides'));
    check('route: saved the path', await page.evaluate(() => { const ch = SillyTavern.getContext().chat; const u = ch.filter(m => m.is_user).pop(); return JSON.stringify(u.extra.worldscrawl_move.via) === '["riverton:streets/square","riverton:temple/nave"]'; }));
    await queue([{ content: 'Back at the tavern.' }]); expected += 1;
    await page.evaluate(() => SillyTavern.getContext().executeSlashCommandsWithOptions('/ws-go The Drowned Rat')); await waitReqs();
    check('/ws-go visited place name', (await stored()) === 'riverton:drowned_rat/common_room', String(await stored()));

    check('seen-but-not-visited place offered (docks)', /Which option: [^?]*River Docks/.test(JSON.stringify(all[all.length - 2].messages)));
    // New chat: the temple is not discovered yet, so it isn't offered and the trip is refused.
    await page.evaluate(() => SillyTavern.getContext().executeSlashCommandsWithOptions('/newchat'));
    await page.waitForTimeout(3000);
    await queue([{ content: 'elsewhere' }]);
    await send('go to the temple', 1);
    lm = await lastMsg();
    const q = JSON.stringify((await lastReq()).messages);
    check('new chat: temple not offered', q.includes('Which option: out, up, back, stay, elsewhere, unclear?') && !q.includes('Temple of the Tides'), q.slice(-160));
    check('new chat: temple refused', lm.sys && /not aware of such a place/.test(lm.mes) && (await stored()) === 'riverton:drowned_rat/common_room', JSON.stringify(lm));

    // Known place but no allowed route: visit the temple, return to the tavern, then hide the square's
    // north exit (stubbed server response; routing never uses hidden exits).
    await queue([{ content: 'a' }, { content: 'b' }, { content: 'c' }, { content: 'd' }]);
    for (const d of ['out', 'north', 'south', 'in']) { expected += 1; await page.evaluate(d => SillyTavern.getContext().executeSlashCommandsWithOptions('/ws-go ' + d), d); await waitReqs(); }
    check('new chat: back in tavern after visiting temple', (await stored()) === 'riverton:drowned_rat/common_room', String(await stored()));
    // rooms reach the extension through /location or the /rooms batch: patch the square in both
    const squareStub = u => u.href.includes('/location/riverton%3Astreets%2Fsquare') || u.href.includes(API + '/rooms');
    const hideNorth = room => (room?.address === 'riverton:streets/square' ? { ...room, exits: room.exits.map(e => e.direction === 'north' ? { direction: 'north', hidden: true } : e) } : room);
    await page.route(squareStub, async route => {
        const r = await route.fetch(); const b = await r.json();
        await route.fulfill({ response: r, json: b.rooms ? { ...b, rooms: b.rooms.map(hideNorth) } : hideNorth(b) });
    });
    await page.evaluate(() => { const i = document.getElementById('worldscrawl_url'); i.dispatchEvent(new Event('input')); }); // clears the location cache
    const nReq = (await (await fetch(`${FAKE}/__requests`)).json()).length;
    await page.evaluate(() => SillyTavern.getContext().executeSlashCommandsWithOptions('/ws-go Temple of the Tides'));
    await page.waitForTimeout(2000);
    lm = await lastMsg();
    check('no route: know-a-way message', lm.sys && lm.mes === "You don't know a way to Temple of the Tides from here. Exits: out (Village Square), up (Upstairs Rooms), back (Courtyard)", JSON.stringify(lm));
    check('no route: no move, no generation', (await stored()) === 'riverton:drowned_rat/common_room' && (await (await fetch(`${FAKE}/__requests`)).json()).length === nReq);
    nb = await noticeBtns();
    check('no route message exits clickable', JSON.stringify(nb[nb.length - 1]) === '["out (Village Square)","up (Upstairs Rooms)","back (Courtyard)"]', JSON.stringify(nb));
    await page.unroute(squareStub);
    await page.evaluate(() => { const i = document.getElementById('worldscrawl_url'); i.dispatchEvent(new Event('input')); }); // drop the stubbed location from the cache
    const nr = await page.evaluate(async () => { const m = await import('/scripts/extensions/third-party/WorldScrawl/index.js'); return [m.noticePrefix('Temple of the Tides'), m.unreachableText({ exits: [{ direction: 'out', to_name: 'Village Square' }] }, 'Temple of the Tides')]; });
    check('no-route message text', nr[0] === "You don't know a way to Temple of the Tides from here." && nr[1] === "You don't know a way to Temple of the Tides from here. Exits: out (Village Square)", JSON.stringify(nr));

    // ---- New map: notes, two "Upstairs Rooms", routing via Market Lane.
    await page.evaluate(() => SillyTavern.getContext().executeSlashCommandsWithOptions('/newchat'));
    await page.waitForTimeout(3000);
    const tour = ['out', 'west', 'inn', 'up', 'down', 'out', 'east', 'in'];
    await queue(tour.map(t => ({ content: 'tour ' + t })));
    for (const d of tour) { expected += 1; await page.evaluate(d => SillyTavern.getContext().executeSlashCommandsWithOptions('/ws-go ' + d), d); await waitReqs(); }
    check('tour back in the tavern', (await stored()) === 'riverton:drowned_rat/common_room', String(await stored()));
    narr = JSON.stringify((await lastReq()).messages);
    check('notes: tavern gets region + subregion notes', narr.includes('About Riverton:') && narr.includes("About The Drowned Rat: Riverton's oldest tavern") && narr.includes('This location: A low-beamed'));
    const lastNotice = () => page.evaluate(() => { const ch = SillyTavern.getContext().chat; const m = ch[ch.length - 1]; const els = [...document.querySelectorAll('#chat .mes')]; return { sys: !!m.is_system, mes: m.mes, btns: [...els[els.length - 1].querySelectorAll('.worldscrawl_candidate')].map(b => b.textContent) }; });

    // Typed "upstairs rooms": the model answers the bare name, which matches both -> which one?
    await queue([{ content: 'Upstairs Rooms' }]);
    await send('go to the upstairs rooms', 1);
    let ln = await lastNotice();
    const both = '["Upstairs Rooms (The Drowned Rat)","Upstairs Rooms (The Gilded Goose)"]';
    check('ambiguous name: which-one message with both', ln.sys && ln.mes.startsWith('Which one do you mean?') && JSON.stringify(ln.btns) === both, JSON.stringify(ln));
    check('ambiguous name: no narration call', (await (await fetch(`${FAKE}/__requests`)).json()).length === expected);
    let iq = JSON.stringify((await lastReq()).messages);
    check('intent: non-adjacent known place shown as Name (Subregion)', iq.includes('Upstairs Rooms (The Gilded Goose)') && iq.includes(', unclear?'), iq.slice(-300));

    // /ws-go with the ambiguous name does the same; only the latest which-message is clickable; survives reload.
    await page.evaluate(() => SillyTavern.getContext().executeSlashCommandsWithOptions('/ws-go Upstairs Rooms'));
    await page.waitForTimeout(1500);
    ln = await lastNotice();
    check('/ws-go ambiguous: which-one message', ln.sys && JSON.stringify(ln.btns) === both, JSON.stringify(ln));
    check('only latest which-message clickable', await page.evaluate(() => { const f = [...document.querySelectorAll('#chat .mes')].filter(e => /Which one do you mean/.test(e.textContent)); return f.length === 2 && f[0].querySelectorAll('.worldscrawl_candidate').length === 0; }));
    await page.reload(); await page.waitForSelector('#send_textarea', { timeout: 60000 }); await page.waitForTimeout(3000);
    await page.evaluate(async () => { await SillyTavern.getContext().selectCharacterById(0); });
    await page.waitForTimeout(3000);
    ln = await lastNotice();
    check('which-message buttons survive reload', JSON.stringify(ln.btns) === both, JSON.stringify(ln));
    await page.evaluate(() => jQuery('#api_button_openai').trigger('click'));
    await page.waitForTimeout(3000);
    await page.evaluate(async () => { const o = await import('/scripts/openai.js'); o.oai_settings.stream_openai = false; });

    // Click the Goose one: routes tavern -> square -> market lane -> goose -> upstairs (all visited).
    await queue([{ content: 'The long walk.' }]); expected += 1;
    await page.click('#chat .mes:last-child .worldscrawl_candidate[data-address="riverton:gilded_goose/upstairs"]');
    await waitReqs();
    check('which button routes to the Goose upstairs', (await stored()) === 'riverton:gilded_goose/upstairs', String(await stored()));
    narr = JSON.stringify((await lastReq()).messages);
    check('route via Market Lane narrated', narr.includes('User travelled from Common Room (The Drowned Rat) through Village Square (Riverton Streets), Market Lane (Riverton Streets), Common Room (The Gilded Goose) to Upstairs Rooms (The Gilded Goose)'), narr.slice(0, 400));

    // 'unclear' answer -> which one, no generation.
    await queue([{ content: 'unclear' }]);
    await send('let us go somewhere', 1);
    ln = await lastNotice();
    check('unclear: which-one message with candidates', ln.sys && ln.mes.startsWith('Which one do you mean?') && ln.btns.length >= 2 && (await stored()) === 'riverton:gilded_goose/upstairs', JSON.stringify(ln));

    // Footer stays short unless names collide.
    const fx = await page.evaluate(async () => { const m = await import('/scripts/extensions/third-party/WorldScrawl/index.js'); return [
        m.exitsText({ exits: [{ direction: 'down', to_name: 'The Gilded Goose', to_subregion: { name: 'The Gilded Goose' } }] }),
        m.exitsText({ exits: [{ direction: 'left', to_name: 'Upstairs Rooms', to_subregion: { name: 'The Drowned Rat' } }, { direction: 'right', to_name: 'Upstairs Rooms', to_subregion: { name: 'The Gilded Goose' } }] })]; });
    const bl = await page.evaluate(async () => { const m = await import('/scripts/extensions/third-party/WorldScrawl/index.js');
        const get = async a => (await fetch('/api/plugins/worldscrawl/location/' + encodeURIComponent(a))).json();
        return [m.exitsText(await get('riverton:streets/market_lane')), m.exitsText(await get('riverton:drowned_rat/courtyard')), m.exitsText({ exits: [{ direction: 'crack', hidden: true }] })]; });
    check('exit labels: building on entrance, building + room otherwise, room within the building, hidden = label only',
        bl[0] === "Exits: east (Village Square), inn (The Gilded Goose), store (Marlow's General Store), smithy (Brask's Smithy), gate (The Drowned Rat, Stable)"
        && bl[1] === 'Exits: in (Common Room), kitchen, stable, trapdoor' && bl[2] === 'Exits: crack', JSON.stringify(bl));
    const mn = await page.evaluate(async () => { const m = await import('/scripts/extensions/third-party/WorldScrawl/index.js'); const mv = { direction: 'x', to_name: 'Secret Vault' };
        return [m.moveNote('User', { ...mv, direction: 'trapdoor' }, { direction: 'trapdoor', hidden: true }), m.moveNote('User', { ...mv, direction: 'crawlspace' }, { direction: 'crawlspace', obscured: true }),
            m.moveNote('User', { ...mv, direction: 'north' }, { direction: 'north', to: 'r:v', to_name: 'Secret Vault' })]; });
    const mv2 = await page.evaluate(async () => { const m = await import('/scripts/extensions/third-party/WorldScrawl/index.js');
        const get = async a => (await fetch('/api/plugins/worldscrawl/location/' + encodeURIComponent(a))).json();
        const note = async (from, dir) => { const l = await get(from); const e = l.exits.find(x => x.direction === dir); return m.moveNote('User', { direction: dir, to_name: e.to_name }, e); };
        return [await note('riverton:drowned_rat/courtyard', 'stable'), await note('riverton:streets/market_lane', 'gate'), await note('riverton:streets/market_lane', 'inn'),
            await note('riverton:drowned_rat/stable', 'gate'), await note('riverton:drowned_rat/common_room', 'out')]; });
    check('non-compass move messages say where they go', JSON.stringify(mv2) === JSON.stringify(['*User goes to the Stable.*', '*User goes through the gate to the Stable of The Drowned Rat.*', '*User goes to The Gilded Goose.*', '*User goes through the gate to Market Lane.*', '*User goes out.*']), JSON.stringify(mv2));
    check('hidden exit move message never names the destination', JSON.stringify(mn) === JSON.stringify(['*User goes through the trapdoor.*', '*User takes the crawlspace exit.*', '*User goes north.*']), JSON.stringify(mn));
    check('footer short / subregion only on collision', fx[0] === 'Exits: down (The Gilded Goose)' && fx[1] === 'Exits: left (Upstairs Rooms, The Drowned Rat), right (Upstairs Rooms, The Gilded Goose)', JSON.stringify(fx));

    // ---- Area names and generic room names (Knarfy's reports).
    await page.evaluate(() => SillyTavern.getContext().executeSlashCommandsWithOptions('/newchat'));
    await page.waitForTimeout(3000);
    const go = async (...dirs) => { await queue(dirs.map(d => ({ content: 'went ' + d }))); for (const d of dirs) { expected += 1; await page.evaluate(d => SillyTavern.getContext().executeSlashCommandsWithOptions('/ws-go ' + d), d); await waitReqs(); } };
    await go('out', 'north');
    check('at the temple', (await stored()) === 'riverton:temple/nave', String(await stored()));
    // Only one Common Room known -> "flee to the common room" goes there even if the model says elsewhere.
    await queue([{ content: 'elsewhere' }, { content: 'You flee.' }]);
    await send('I flee to the common room', 2);
    check('one known Common Room: goes there', (await stored()) === 'riverton:drowned_rat/common_room', String(await stored()));
    // Walk to Marlow's, then the building name "The Drowned Rat" (typed) resolves to its entrance.
    await go('out', 'west', 'store');
    check('at the store', (await stored()) === 'riverton:general_store/shop', String(await stored()));
    await queue([{ content: 'The Drowned Rat' }, { content: 'Back to the Rat.' }]);
    await send('go to the drowned rat', 2);
    check('typed building name -> entrance room', (await stored()) === 'riverton:drowned_rat/common_room', String(await stored()));
    check('building name narrated as journey', JSON.stringify((await lastReq()).messages).includes("travelled from Marlow's General Store through Market Lane (Riverton Streets), Village Square (Riverton Streets) to Common Room (The Drowned Rat)"));
    await go("Marlow's General Store");
    check('/ws-go shop name routes back', (await stored()) === 'riverton:general_store/shop', String(await stored()));
    await go('The Drowned Rat');
    check('/ws-go building name -> entrance', (await stored()) === 'riverton:drowned_rat/common_room', String(await stored()));
    // Both Common Rooms known (the Goose was seen from Market Lane) -> which one.
    await go('Temple of the Tides');
    const nGen = (await (await fetch(`${FAKE}/__requests`)).json()).length;
    await queue([{ content: 'elsewhere' }]);
    await send('I flee to the common room', 1);
    const wn = await page.evaluate(() => { const ch = SillyTavern.getContext().chat; const m = ch[ch.length - 1]; const els = [...document.querySelectorAll('#chat .mes')]; return { sys: !!m.is_system, mes: m.mes, btns: [...els[els.length - 1].querySelectorAll('.worldscrawl_candidate')].map(b => b.textContent) }; });
    check('two Common Rooms: which one', wn.sys && wn.mes.startsWith('Which one do you mean?') && JSON.stringify([...wn.btns].sort()) === '["Common Room (The Drowned Rat)","Common Room (The Gilded Goose)"]', JSON.stringify(wn));
    check('two Common Rooms: no narration, no move', (await (await fetch(`${FAKE}/__requests`)).json()).length === nGen + 1 && (await stored()) === 'riverton:temple/nave');
    const iq2 = JSON.stringify((await lastReq()).messages);
    check('intent labels rooms with their building', iq2.includes('Common Room (The Drowned Rat)') && iq2.includes('Common Room (The Gilded Goose)'), iq2.slice(-400));
    // Both Upstairs Rooms known -> "go upstairs" from the temple asks which one.
    await go('Common Room (The Gilded Goose)', 'up', 'down', 'Temple of the Tides');
    check('back at the temple', (await stored()) === 'riverton:temple/nave', String(await stored()));
    await queue([{ content: 'elsewhere' }]);
    await send('go upstairs', 1);
    const wu = await page.evaluate(() => { const ch = SillyTavern.getContext().chat; const m = ch[ch.length - 1]; const els = [...document.querySelectorAll('#chat .mes')]; return { sys: !!m.is_system, btns: [...els[els.length - 1].querySelectorAll('.worldscrawl_candidate')].map(b => b.textContent) }; });
    check('"go upstairs" with both known: which one', wu.sys && JSON.stringify([...wu.btns].sort()) === '["Upstairs Rooms (The Drowned Rat)","Upstairs Rooms (The Gilded Goose)"]', JSON.stringify(wu));
    const pm = await page.evaluate(async () => { const m = await import('/scripts/extensions/third-party/WorldScrawl/index.js');
        const c = [{ name: 'Upstairs Rooms', label: 'Upstairs Rooms (The Drowned Rat)', address: 'a' }, { name: 'Upstairs', label: 'Upstairs (The Gilded Goose)', address: 'b' }, { name: 'Common Room', label: 'Common Room (The Drowned Rat)', address: 'c' }, { name: 'Common Room', label: 'Common Room (The Gilded Goose)', address: 'd' }];
        return [m.namedInText('I flee UPSTAIRS!', c).map(x => x.address).join(), m.namedInText('to the common room of the drowned rat', c).map(x => x.address).join(), m.namedInText('I smile', c).length]; });
    check('name matching: partial words, case, building tiebreak', JSON.stringify(pm) === '["a,b","c",0]', JSON.stringify(pm));
    // Already inside the named building/region: short notice, no move, no narration.
    const nA = (await (await fetch(`${FAKE}/__requests`)).json()).length;
    await queue([{ content: 'elsewhere' }]);
    await send('go to the temple', 1);
    let al = await page.evaluate(() => { const ch = SillyTavern.getContext().chat; const m = ch[ch.length - 1]; const els = [...document.querySelectorAll('#chat .mes')]; return { sys: !!m.is_system, mes: m.mes, btns: [...els[els.length - 1].querySelectorAll('.worldscrawl_exit')].length }; });
    check('typed: already in the temple', al.sys && al.mes === "You're already in Temple of the Tides. Exits: south (Village Square), grate" && al.btns === 2, JSON.stringify(al));
    await page.evaluate(() => SillyTavern.getContext().executeSlashCommandsWithOptions('/ws-go Riverton'));
    await page.waitForTimeout(1500);
    al = await page.evaluate(() => { const ch = SillyTavern.getContext().chat; return ch[ch.length - 1].mes; });
    check('/ws-go: already in Riverton', al === "You're already in Riverton. Exits: south (Village Square), grate", al);
    check('already: no move, no narration', (await stored()) === 'riverton:temple/nave' && (await (await fetch(`${FAKE}/__requests`)).json()).length === nA + 1);

    // Stable gate onto Market Lane: building travel uses the nearest room already stood in.
    await go("Marlow's General Store", 'The Drowned Rat');
    check('stable never visited: building -> common room', (await stored()) === 'riverton:drowned_rat/common_room', String(await stored()));
    // Leaving words: "I leave the Drowned Rat" takes the only exit out of the building; "we flee Riverton" has none -> not aware.
    await queue([{ content: 'elsewhere' }, { content: 'You step out.' }]);
    await send('I leave the Drowned Rat', 2);
    check('leave the building: takes the one way out', (await stored()) === 'riverton:streets/square', String(await stored()));
    await go('in');
    const nF = (await (await fetch(`${FAKE}/__requests`)).json()).length;
    await queue([{ content: 'elsewhere' }]);
    await send('we flee Riverton', 1);
    const fl = await page.evaluate(() => { const ch = SillyTavern.getContext().chat; return ch[ch.length - 1]; });
    check('flee the region with no way out: not aware, no move, no narration', fl.is_system && fl.mes.startsWith("You're not aware of such a place.") && (await stored()) === 'riverton:drowned_rat/common_room' && (await (await fetch(`${FAKE}/__requests`)).json()).length === nF + 1, fl.mes);
    const lw = await page.evaluate(async () => { const m = await import('/scripts/extensions/third-party/WorldScrawl/index.js'); return [m.LEAVING_RE.test('we get away from here'), m.LEAVING_RE.test('I go to the temple') || m.LEAVING_RE.test('the stairs on the left'), m.whichText([{ label: 'out (Village Square)' }, { label: 'gate (Market Lane)' }], m.WAY_OUT_PREFIX)]; });
    const pl = await page.evaluate(async () => { const m = await import('/scripts/extensions/third-party/WorldScrawl/index.js'); const grate = { direction: 'grate', description: 'A stone stair behind an iron grate.' };
        return [m.sameWord('grate', 'grates'), m.sameWord('Stables', 'stable'), m.sameWord('box', 'boxes'), m.sameWord('kitchen', 'Kitchens'), m.sameWord('grate', 'grat'), m.sameWord('stable', 'stabl'), m.sameWord('box', 'boxe') && false,
            m.sameLabel('Kitchens', 'kitchen'), m.sameLabel('The Forge', 'forge'), m.sameLabel('Stable', 'stables'), m.sameLabel('Upstairs Rooms', 'upstairs'),
            m.sameAsDirection({ direction: 'stable', to_name: 'Stable' }), m.sameAsDirection({ direction: 'kitchen', to_label: 'Kitchens' }),
            m.exitMentioned('I go through the grates', grate), m.exitMentioned('I take the stairs down', grate), m.exitMentioned('I go to the temple', grate),
            m.namedInText('go upstairs', [{ name: 'Upstairs Rooms', label: 'Upstairs Rooms', address: 'u' }]).length, m.namedInText('the common room', [{ name: 'Common Room', label: 'Common Room', address: 'c' }]).length]; });
    check('plural-tolerant word matching (grate/grates, stable/stables, box/boxes, kitchen/kitchens; no stem mangling)',
        JSON.stringify(pl) === '[true,true,true,true,false,false,false,true,true,true,false,true,true,true,true,false,1,1]', JSON.stringify(pl));
    check('leaving words + way-out text', JSON.stringify(lw) === '[true,false,"Which way out? out (Village Square), gate (Market Lane)"]', JSON.stringify(lw));
    await go('out', 'west', 'gate');
    check('stable reached via the gate', (await stored()) === 'riverton:drowned_rat/stable', String(await stored()));
    await go('gate', 'store', 'The Drowned Rat');
    check('after visiting the stable: building -> stable', (await stored()) === 'riverton:drowned_rat/stable', String(await stored()));
    // Building by name from further away (Goose upstairs: stable 3 steps, common room 4; the store: 2 vs 3).
    const stableDesc = await page.evaluate(async () => (await (await fetch('/api/plugins/worldscrawl/location/' + encodeURIComponent('riverton:drowned_rat/stable'))).json()).description);
    const typedTo = async (text, answer) => { await queue([{ content: answer }, { content: 'You walk.' }]); await send(text, 2); };
    await go('gate', 'inn', 'up');
    await typedTo('go to the Drowned Rat', 'The Drowned Rat');
    check('Goose upstairs -> "the Drowned Rat" lands in the stable', (await stored()) === 'riverton:drowned_rat/stable', String(await stored()));
    await go('gate', 'inn', 'up');
    await typedTo('go to the Drowned Rat', 'Common Room (The Drowned Rat)');
    check('model picks the entrance room for a building name: still the nearest room', (await stored()) === 'riverton:drowned_rat/stable', String(await stored()));
    await go('gate', 'store');
    await typedTo('go to the Drowned Rat', 'Common Room (The Drowned Rat)');
    check('store -> "the Drowned Rat" lands in the stable', (await stored()) === 'riverton:drowned_rat/stable', String(await stored()));
    const arrNote = JSON.stringify((await lastReq()).messages); // the arrival turn's own narration request
    check('arrival note on the same turn: Stable is the current room, with its description, entered through the gate',
        arrNote.includes('Current location: Stable, The Drowned Rat') && arrNote.includes('This location: ' + stableDesc)
        && arrNote.includes('User arrives in the Stable of The Drowned Rat, entering through the gate from Market Lane. They are in the Stable, not the Common Room or any other part of The Drowned Rat.')
        && (await lastReq()).messages.slice(-2).some(m => m.content.includes('[Engine: this turn ends in the Stable of The Drowned Rat. Do not narrate entering any other room. If the player\'s message assumes they arrive somewhere else or do things there, they actually stopped in the Stable of The Drowned Rat. Keep their intent where it fits (they may notice or want the other place), but do not narrate them reaching it.]'))
        && arrNote.includes('ending with arriving in the Stable of The Drowned Rat') && !arrNote.includes('Current location: Common Room'), arrNote.slice(0, 1500));
    await go('gate', 'smithy');
    await typedTo('go to the Drowned Rat', 'The Drowned Rat');
    check("Brask's Smithy -> the Drowned Rat lands in the stable", (await stored()) === 'riverton:drowned_rat/stable', String(await stored()));
    await queue([{ content: 'stay' }, { content: 'You brush the horse.' }]);
    await send('I brush the horse', 2);
    check('no arrival reminder on a turn without a move', !JSON.stringify((await lastReq()).messages).includes('[Engine: this turn ends'));
    await go('gate', 'store');
    await typedTo('go to the common room of the Drowned Rat', 'Common Room (The Drowned Rat)');
    check('room named explicitly: that room', (await stored()) === 'riverton:drowned_rat/common_room', String(await stored()));
    const ta = await page.evaluate(async () => { const m = await import('/scripts/extensions/third-party/WorldScrawl/index.js'); return ['"Common Room (The Drowned Rat)."', '(north)', '**Upstairs Rooms (The Gilded Goose)**', 'north)'].map(m.trimAnswer); });
    check('answers keep a label\'s closing parenthesis', JSON.stringify(ta) === JSON.stringify(['Common Room (The Drowned Rat)', 'north', 'Upstairs Rooms (The Gilded Goose)', 'north']), JSON.stringify(ta));
    await go('back', 'stable');

    // Leaving from rooms with no exit out: route through visited rooms to the nearest way out.
    await page.evaluate(() => SillyTavern.getContext().executeSlashCommandsWithOptions('/newchat'));
    await page.waitForTimeout(3000);
    await go('up');
    await queue([{ content: 'elsewhere' }, { content: 'Out you go.' }]);
    await send('I leave the Drowned Rat', 2);
    check('leave from upstairs -> Village Square', (await stored()) === 'riverton:streets/square', String(await stored()));
    await go('in', 'back', 'kitchen');
    await queue([{ content: 'elsewhere' }, { content: 'Out you go.' }]);
    await send('I leave the Drowned Rat', 2);
    check('leave from kitchens (stable unvisited) -> Village Square', (await stored()) === 'riverton:streets/square', String(await stored()));
    await go('in', 'back', 'stable');
    await queue([{ content: 'elsewhere' }, { content: 'Out the gate.' }]);
    await send('I leave the Drowned Rat', 2);
    check('leave from the stable -> out the gate to Market Lane', (await stored()) === 'riverton:streets/market_lane', String(await stored()));
    await go('east', 'in');
    await queue([{ content: 'elsewhere' }]);
    await send('we take the stairs on the left in the Drowned Rat', 1);
    const lf = await page.evaluate(() => { const ch = SillyTavern.getContext().chat; return ch[ch.length - 1]; });
    check('"on the left" is not leaving', lf.is_system && lf.mes.startsWith("You're already in The Drowned Rat.") && (await stored()) === 'riverton:drowned_rat/common_room', lf.mes);

    // ---- Request trimming: cold cache, fresh chat, one typed turn -> /start at most once, each location once.
    await page.evaluate(() => { const i = document.getElementById('worldscrawl_url'); i.dispatchEvent(new Event('input')); }); // clears the cache
    apiCalls.length = 0;
    await page.evaluate(() => SillyTavern.getContext().executeSlashCommandsWithOptions('/newchat'));
    await page.waitForTimeout(3000);
    check('greeting stamped with start location', await page.evaluate(() => SillyTavern.getContext().chat[0]?.extra?.worldscrawl_location === 'riverton:drowned_rat/common_room'));
    await queue([{ content: 'stay' }, { content: 'You sip your ale.' }]);
    await send('I sip my ale', 2);
    check('fresh chat + first turn: only /start (no neighbour fetches)', JSON.stringify(apiCalls.filter(u => u !== '/worlds')) === '["/start"]', JSON.stringify(apiCalls));
    apiCalls.length = 0;
    await queue([{ content: 'out' }, { content: 'The square.' }]);
    await send('I head outside', 2);
    check('typed move turn: only /move', JSON.stringify(apiCalls) === '["/move"]', JSON.stringify(apiCalls));
    // 'Who moves' setting: macros resolved by the extension.
    const oldWho = await page.evaluate(async () => { const m = await import('/scripts/extensions/third-party/WorldScrawl/index.js'); const es = SillyTavern.getContext().extensionSettings;
        const keep = es.worldscrawl; es.worldscrawl = { serverUrl: keep.serverUrl, moveMode: 'typed' }; const w = [m.settings().whoMoves, m.whoMoves()]; es.worldscrawl = keep; return w; });
    check('old saved settings without Who moves get {{user}}', oldWho[0] === '{{user}}' && oldWho[1] === 'User', JSON.stringify(oldWho));
    await page.evaluate(() => { const i = document.getElementById('worldscrawl_who'); i.value = 'Sir {{user}}'; i.dispatchEvent(new Event('input')); });
    apiCalls.length = 0;
    await go('north');
    check('command move: only /move', JSON.stringify(apiCalls) === '["/move"]', JSON.stringify(apiCalls));
    check('who-moves: custom phrase with macro in move message', await page.evaluate(() => SillyTavern.getContext().chat.some(m => m.is_user && m.mes === '*Sir User goes north.*')));
    check('who-moves: custom phrase in model notes', JSON.stringify((await lastReq()).messages).includes('Sir User moved north from Village Square'));
    await page.evaluate(() => { const i = document.getElementById('worldscrawl_who'); i.value = '{{user}}'; i.dispatchEvent(new Event('input')); });
    // Fast travel is one /travel request (no per-step /move).
    apiCalls.length = 0;
    await go('The Drowned Rat');
    check('fast travel: exactly one request (/travel)', (await stored()) === 'riverton:drowned_rat/common_room' && JSON.stringify(apiCalls) === '["/travel"]', JSON.stringify(apiCalls));
    narr = JSON.stringify((await lastReq()).messages);
    check('journey note lists rooms in order', narr.includes('User travelled from Temple of the Tides through Village Square (Riverton Streets) to Common Room (The Drowned Rat). User arrives in the Common Room of The Drowned Rat. Narrate the journey briefly, in that order, ending with arriving in the Common Room of The Drowned Rat.'), narr.slice(0, 300));
    // A server-side stop (here: a blocked step injected into the request) leaves the party at the last valid room.
    const travelStub = u => u.pathname.endsWith('/travel');
    await page.route(travelStub, async route => { const b = JSON.parse(route.request().postData()); b.steps.splice(1, 0, 'bogus'); await route.continue({ postData: JSON.stringify(b) }); });
    await go('Temple of the Tides');
    await page.unroute(travelStub);
    check('server stop: party at last valid room, not the destination', (await stored()) === 'riverton:streets/square', String(await stored()));
    // Reload: the room cache is rebuilt with at most one batch request, never one request per room.
    apiCalls.length = 0;
    await page.reload(); await page.waitForSelector('#send_textarea', { timeout: 60000 }); await page.waitForTimeout(3000);
    await page.evaluate(async () => { await SillyTavern.getContext().selectCharacterById(0); });
    await page.waitForTimeout(4000);
    check('reload: at most one /rooms batch, no per-room /location', apiCalls.filter(u => u === '/rooms').length <= 1 && !apiCalls.some(u => u.startsWith('/location/')) && (await stored()) === 'riverton:streets/square', JSON.stringify(apiCalls));
    check('reload: footer rebuilt', await page.evaluate(() => [...document.querySelectorAll('#chat .worldscrawl_exits')].length > 0));
    await page.evaluate(() => jQuery('#api_button_openai').trigger('click'));
    await page.waitForTimeout(3000);
    await page.evaluate(async () => { const o = await import('/scripts/openai.js'); o.oai_settings.stream_openai = false; });
    check('no Content-Type on GET requests (no CORS preflight)', typedGets.length === 0, JSON.stringify(typedGets.slice(0, 3)));
    // A changed map version on any reply drops the remembered rooms.
    const before2 = await page.evaluate(async () => (await import('/scripts/extensions/third-party/WorldScrawl/index.js')).cacheInfo());
    const verStub = u => u.pathname.endsWith('/health');
    await page.route(verStub, async route => { const r = await route.fetch(); await route.fulfill({ response: r, headers: { ...r.headers(), 'x-worldscrawl-map-version': 'changed-for-test', 'access-control-expose-headers': 'X-WorldScrawl-Map-Version' } }); });
    await page.evaluate(() => jQuery('#worldscrawl_test').trigger('click'));
    await page.waitForTimeout(1500);
    await page.unroute(verStub);
    const after2 = await page.evaluate(async () => (await import('/scripts/extensions/third-party/WorldScrawl/index.js')).cacheInfo());
    check('changed map version clears the cache', before2.size > 0 && before2.mapVersion && after2.size === 0 && after2.mapVersion === 'changed-for-test', JSON.stringify([before2, after2]));
    const everyReq = await (await fetch(`${FAKE}/__requests`)).json();
    const leaks = everyReq.map(r => JSON.stringify(r)).filter(t => t.includes('{{'));
    const chatLeaks = await page.evaluate(() => SillyTavern.getContext().chat.filter(m => m.mes?.includes('{{')).map(m => m.mes));
    check('no hardcoded "The party" in model requests or chat', !everyReq.some(r => /the party/i.test(JSON.stringify(r.messages))) && await page.evaluate(() => !SillyTavern.getContext().chat.some(m => /the party/i.test(m.mes ?? ''))));
    check('no raw {{macros}} in any model request (intent questions, notes) or chat message', !leaks.length && !chatLeaks.length, (leaks[0] ?? '').slice(0, 300) + JSON.stringify(chatLeaks));
    // Obscured exits: label only until the party walks through that door (either side); derived from move stamps.
    const wsExits = () => page.evaluate(async () => (await SillyTavern.getContext().executeSlashCommandsWithOptions('/ws-exits')).pipe);
    const wsGo = async arg => { await page.evaluate(a => SillyTavern.getContext().executeSlashCommandsWithOptions('/ws-go ' + a), arg); await page.waitForTimeout(1500); };
    const lastMes = () => page.evaluate(() => { const ch = SillyTavern.getContext().chat; return ch[ch.length - 1].mes; });
    await go('north');
    check('obscured: temple grate shows only its label', (await wsExits()) === 'Exits: south (Village Square), grate');
    const reqsBefore = (await (await fetch(`${FAKE}/__requests`)).json()).length;
    await wsGo('Temple Catacombs');
    check('obscured: destination not a known place before passing', (await lastMes()).startsWith("You're not aware of such a place.") && (await stored()) === 'riverton:temple/nave');
    const nl = (await (await fetch(`${FAKE}/__requests`)).json()).slice(0, reqsBefore).map(r => JSON.stringify(r));
    check('obscured: destination never in any model request before reveal', !nl.some(t => t.includes('Catacombs')));
    const chatLen = await page.evaluate(() => SillyTavern.getContext().chat.length);
    await go('grate');
    check('obscured: move through grate works, message names no destination', (await stored()) === 'riverton:temple/catacombs'
        && await page.evaluate(() => SillyTavern.getContext().chat.some(m => m.is_user && m.mes === '*User goes through the grate.*')));
    await go('up');
    check('obscured: revealed after passing through', (await wsExits()) === 'Exits: south (Village Square), grate (Temple Catacombs)', String(await wsExits()));
    // Swipe/delete back past the move: the reveal rolls back.
    await page.evaluate(async n => { const c = SillyTavern.getContext(); c.chat.splice(n); await c.saveChat(); await c.eventSource.emit(c.eventTypes.MESSAGE_DELETED, n); }, chatLen);
    check('obscured: deleting the move un-reveals the door', (await stored()) === 'riverton:temple/nave' && (await wsExits()) === 'Exits: south (Village Square), grate', String(await wsExits()));
    // (B) Unknown place named, model guesses the unrevealed grate: rejected -> "not aware" notice, no move.
    await queue([{ content: 'grate' }]);
    await send('I go to the secret tunnel', 1); await page.waitForTimeout(1500);
    check('typed: unknown place never mapped onto an unrevealed obscured exit', (await stored()) === 'riverton:temple/nave' && (await lastMes()).startsWith("You're not aware of such a place."), await lastMes());
    const lenB = await page.evaluate(() => SillyTavern.getContext().chat.length);
    await typedTo('I go down the stair', 'grate');
    check('typed: naming the door itself still goes through it', (await stored()) === 'riverton:temple/catacombs', String(await stored()));
    await typedTo('I go into the tunnel', 'tunnel');
    check('typed: "I go into the tunnel" moves normally, no new opening offered', (await stored()) === 'riverton:secret_tunnel/tunnel' && !JSON.stringify((await (await fetch(`${FAKE}/__requests`)).json()).at(-2)).includes('new opening'), String(await stored()));
    await page.evaluate(async n => { const c = SillyTavern.getContext(); c.chat.splice(n); await c.saveChat(); await c.eventSource.emit(c.eventTypes.MESSAGE_DELETED, n); }, lenB);
    // Stood in the catacombs (location stamp) without passing the door: fast travel refuses the unrevealed exit.
    await page.evaluate(async () => { const c = SillyTavern.getContext(); c.chat.push({ name: 'User', is_user: true, mes: 'x', extra: { worldscrawl_location: 'riverton:temple/catacombs', worldscrawl_intent_checked: true } },
        { name: 'User', is_user: true, mes: 'y', extra: { worldscrawl_location: 'riverton:streets/square', worldscrawl_intent_checked: true } }); await c.saveChat(); });
    await wsGo('Temple Catacombs');
    check('obscured: fast travel never routes through an unrevealed door', (await lastMes()).startsWith("You don't know a way to Temple Catacombs") && (await stored()) === 'riverton:streets/square', await lastMes());
    // Walking the OTHER side (catacombs -> temple, a normal exit) reveals the temple's grate too; then travel uses it.
    await page.evaluate(async () => { const c = SillyTavern.getContext(); c.chat.push({ name: 'User', is_user: true, mes: 'z', extra: { worldscrawl_location: 'riverton:temple/nave', worldscrawl_intent_checked: true,
        worldscrawl_move: { direction: 'up', from: 'riverton:temple/catacombs', to: 'riverton:temple/nave' } } }, { name: 'User', is_user: true, mes: 'w', extra: { worldscrawl_location: 'riverton:streets/square', worldscrawl_intent_checked: true } }); await c.saveChat(); });
    apiCalls.length = 0;
    await go('Temple Catacombs');
    check('obscured: return side reveals it; fast travel through revealed door', (await stored()) === 'riverton:temple/catacombs' && apiCalls.includes('/travel'), JSON.stringify(apiCalls));
    check('obscured: travel stamp records steps', await page.evaluate(() => { const ch = SillyTavern.getContext().chat; return JSON.stringify(ch[ch.length - 2].extra.worldscrawl_move?.steps ?? ch.findLast(m => m.extra?.worldscrawl_move?.steps)?.extra.worldscrawl_move.steps); }) === '["north","grate"]');
    // (A) Tunnel visited, grate revealed: from the nave "the secret tunnel" ends in the Secret Tunnel, even if the model picks the grate.
    await page.evaluate(async () => { const c = SillyTavern.getContext(); c.chat.push({ name: 'User', is_user: true, mes: 't', extra: { worldscrawl_location: 'riverton:secret_tunnel/tunnel', worldscrawl_intent_checked: true } },
        { name: 'User', is_user: true, mes: 'n', extra: { worldscrawl_location: 'riverton:temple/nave', worldscrawl_intent_checked: true } }); await c.saveChat(); });
    await typedTo('I go to the secret tunnel', 'Secret Tunnel');
    check('typed: nave -> Secret Tunnel through the revealed grate', (await stored()) === 'riverton:secret_tunnel/tunnel', String(await stored()));
    await page.evaluate(async () => { const c = SillyTavern.getContext(); c.chat.push({ name: 'User', is_user: true, mes: 'n', extra: { worldscrawl_location: 'riverton:temple/nave', worldscrawl_intent_checked: true } }); await c.saveChat(); });
    await typedTo('I go to the secret tunnel', 'grate');
    check('typed: model picks the grate for a named known place beyond it -> still the Secret Tunnel', (await stored()) === 'riverton:secret_tunnel/tunnel', String(await stored()));
    // Worlds: list, chat world stamp, dig/remove changes on system messages, save + rebase, delete-back revert, missing room.
    const M = fn => page.evaluate(async src => { const m = await import('/scripts/extensions/third-party/WorldScrawl/index.js'); return (0, eval)(src)(m); }, fn.toString());
    const wl = await (await stFetch('/worlds')).json();
    check('worlds: list has riverton as default', wl.default === 'riverton' && wl.worlds.some(w => w.id === 'riverton' && w.map_version), JSON.stringify(wl));
    check('worlds: path traversal rejected', (await stFetch('/start?world=..%2Fx')).status === 400 && (await stFetch('/worlds/render', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: '../evil' }) })).status === 400);
    check('chat world stamped on the first message', await page.evaluate(() => { const w = SillyTavern.getContext().chat[0].extra?.worldscrawl_world; return w?.id === 'riverton' && w.version?.length === 12; }));
    await page.evaluate(() => SillyTavern.getContext().executeSlashCommandsWithOptions('/ws-dig oneway=true shortcut Village Square'));
    await page.waitForTimeout(1000);
    check('dig: system message with the change', (await lastMes()) === '[Engine: a passage shortcut to Village Square was opened.]' && await page.evaluate(() => { const ch = SillyTavern.getContext().chat; const m = ch[ch.length - 1]; return m.is_system && m.extra.worldscrawl_change?.type === 'add_exit'; }), await lastMes());
    check('dig: new exit listed', (await wsExits()).includes('shortcut (Village Square)'), String(await wsExits()));
    await go('shortcut');
    check('dig: moving through the dug exit (server applies the changes)', (await stored()) === 'riverton:streets/square', String(await stored()));
    await page.evaluate(() => SillyTavern.getContext().executeSlashCommandsWithOptions('/ws-removeexit east'));
    await page.waitForTimeout(1000);
    check('removeexit: system message + exit gone', (await lastMes()) === '[Engine: the east exit from Village Square was removed.]' && !(await wsExits()).includes('east ('), String(await wsExits()));
    const rebaseAt = await page.evaluate(() => SillyTavern.getContext().chat.length - 1);
    await page.evaluate(() => SillyTavern.getContext().executeSlashCommandsWithOptions('/ws-save-world Test World'));
    await page.waitForTimeout(1500);
    const rb = await M(m => ({ w: m.chatWorld(), ch: m.chatChanges().length }));
    check('save world: chat rebased onto the new world, earlier changes baked in', rb.w?.id === 'test-world' && rb.w.name === 'Test World' && rb.w.rebase && rb.w.at === rebaseAt + 1 && rb.ch === 0 && (await lastMes()) === '[Engine: world saved as "Test World". This chat now uses it.]', JSON.stringify(rb));
    const rendered = await (await stFetch('/location/' + encodeURIComponent('riverton:streets/square') + '?world=test-world')).json();
    check('save world: rendered world has the changes, chat keeps working on it', !rendered.exits.some(e => e.direction === 'east') && !(await wsExits()).includes('east (') && (await stored()) === 'riverton:streets/square');
    check('save world: pristine by default (no knowledge file)', (await (await stFetch('/worlds')).json()).worlds.find(w => w.id === 'test-world')?.has_knowledge === false);
    check('save world: refuses to overwrite', (await stFetch('/worlds/render', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'riverton' }) })).status === 409);
    await page.evaluate(() => SillyTavern.getContext().executeSlashCommandsWithOptions('/ws-removeexit south'));
    await page.waitForTimeout(1000);
    check('after rebase only later changes are replayed', JSON.stringify(await M(m => m.chatChanges().map(c => c.type + ':' + c.direction))) === '["remove_exit:south"]' && !(await wsExits()).includes('south ('));
    await page.evaluate(async n => { const c = SillyTavern.getContext(); c.chat.splice(n); await c.saveChat(); await c.eventSource.emit(c.eventTypes.MESSAGE_DELETED, n); }, rebaseAt);
    await page.waitForTimeout(1000);
    const back = await M(m => ({ w: m.chatWorld()?.id, ch: m.chatChanges().map(c => c.type) }));
    check('deleting back past the rebase reverts to the previous world and its changes', back.w === 'riverton' && JSON.stringify(back.ch) === '["add_exit"]' && (await wsExits()).includes('east (') && (await wsExits()).includes('south ('), JSON.stringify(back) + (await wsExits()));
    await page.evaluate(async () => { const c = SillyTavern.getContext(); c.chat.push({ name: 'User', is_user: true, mes: 'v', extra: { worldscrawl_location: 'riverton:nowhere/void', worldscrawl_intent_checked: true } }); await c.saveChat(); });
    const exMissing = await wsExits();
    check('missing room: falls back to the start with a system notice', (await lastMes()).includes('no longer exists in this world') && (await stored()) === 'riverton:drowned_rat/common_room' && exMissing.startsWith('Exits: out'), exMissing + ' | ' + (await lastMes()));
        // Swiping the greeting keeps/restamps the start location.
    await page.evaluate(async () => { const c = SillyTavern.getContext(); delete c.chat[0].extra.worldscrawl_location; for (let i = 1; i < c.chat.length; i++) if (c.chat[i].extra) delete c.chat[i].extra.worldscrawl_location; await c.eventSource.emit(c.eventTypes.MESSAGE_SWIPED, 0); });
    await page.waitForTimeout(1000);
    check('greeting restamped after swipe', await page.evaluate(() => SillyTavern.getContext().chat[0]?.extra?.worldscrawl_location === 'riverton:drowned_rat/common_room'));
    // Save "with knowledge", then a new chat on that world starts from the saved knowledge (seed + later stamps).
    await page.evaluate(() => SillyTavern.getContext().executeSlashCommandsWithOptions('/ws-save-world switch=false Know World --knowledge'));
    await page.waitForTimeout(1500);
    const kn = (await (await stFetch('/worlds/know-world/knowledge')).json()).knowledge;
    check('save with knowledge: knowledge.json has location, places and revealed doors', kn && kn.location === 'riverton:drowned_rat/common_room' && kn.stood.includes('riverton:temple/catacombs') && kn.doors.length >= 1 && (await M(m => m.chatWorld()?.id)) === 'riverton', JSON.stringify(kn));
    await page.evaluate(async () => { const m = await import('/scripts/extensions/third-party/WorldScrawl/index.js'); const c = SillyTavern.getContext();
        c.chat.splice(1); for (const x of [c.chat[0], ...(c.chat[0].swipe_info ?? [])]) if (x?.extra) { delete x.extra.worldscrawl_location; delete x.extra.worldscrawl_world; }
        c.extensionSettings.worldscrawl.world = 'know-world'; await m.ensureStartStamp(); c.extensionSettings.worldscrawl.world = ''; });
    const seeded = await page.evaluate(() => SillyTavern.getContext().chat[0].extra);
    check('new chat on a knowledge world: seeded on message 0 with start at the saved location', seeded.worldscrawl_world?.id === 'know-world' && seeded.worldscrawl_world.seed?.doors?.length >= 1 && seeded.worldscrawl_location === 'riverton:drowned_rat/common_room', JSON.stringify(seeded).slice(0, 300));
    await go('Temple Catacombs');
    check('seeded knowledge: fast travel through seeded places and seeded revealed door', (await stored()) === 'riverton:temple/catacombs', String(await stored()));
    // Enabled toggle: off = no prompts, no footers, no intent/server calls, no stamps; on = rebuilt from stamps.
    const prompts = () => page.evaluate(() => { const p = SillyTavern.getContext().extensionPrompts ?? {}; return ['worldscrawl_facts', 'worldscrawl_arrival_reminder', 'worldscrawl_nudge'].map(k => p[k]?.value ?? ''); });
    const footers = () => page.evaluate(() => document.querySelectorAll('#chat .worldscrawl_exits').length);
    const locBefore = await stored();
    await page.evaluate(() => { const b = document.getElementById('worldscrawl_enabled'); b.checked = false; b.dispatchEvent(new Event('change')); });
    await page.waitForTimeout(1000);
    const pOff = await prompts();
    check('toggle off: all injections cleared, footers removed', pOff.every(v => !v) && (await footers()) === 0 && await page.evaluate(() => SillyTavern.getContext().chatMetadata.worldscrawl_enabled === false), JSON.stringify(pOff));
    const nReqOff = (await (await fetch(`${FAKE}/__requests`)).json()).length;
    apiCalls.length = 0;
    await queue([{ content: 'You stay put, the engine sleeps.' }]);
    await send('I go out to the village square', 1);
    const offReqs = (await (await fetch(`${FAKE}/__requests`)).json()).slice(nReqOff);
    const lastUser = await page.evaluate(() => { const ch = SillyTavern.getContext().chat; return [...ch].reverse().find(m => m.is_user)?.extra ?? {}; });
    check('toggle off: move-like message ignored (no intent question, no server call, no stamp, no world state)', offReqs.length === 1 && !JSON.stringify(offReqs).includes('World state') && !JSON.stringify(offReqs).includes('classify')
        && apiCalls.length === 0 && !lastUser.worldscrawl_location && !lastUser.worldscrawl_move && (await stored()) === locBefore && (await footers()) === 0, JSON.stringify([offReqs.length, apiCalls, lastUser]));
    check('toggle off: slash command says so', (await page.evaluate(async () => (await SillyTavern.getContext().executeSlashCommandsWithOptions('/ws-exits')).pipe)) === 'WorldScrawl is turned off.');
    await page.evaluate(() => { const b = document.getElementById('worldscrawl_enabled'); b.checked = true; b.dispatchEvent(new Event('change')); });
    await page.waitForTimeout(2000);
    const pOn = await prompts();
    check('toggle on: world state re-injected and footers back, location from earlier stamps', pOn[0].includes('[World state from the game engine') && (await footers()) > 0 && (await stored()) === locBefore
        && (await wsExits()).startsWith('Exits:'), JSON.stringify(pOn).slice(0, 200));
    // A chat started while off has no stamps; nothing is stamped while off, even on chat load; turning on stamps the greeting.
    const toggle = on => page.evaluate(v => { const b = document.getElementById('worldscrawl_enabled'); b.checked = v; b.dispatchEvent(new Event('change')); }, on);
    await toggle(false); await page.waitForTimeout(500);
    await page.evaluate(async () => { const c = SillyTavern.getContext(); c.chat.splice(1);
        for (const x of [c.chat[0], ...(c.chat[0].swipe_info ?? [])]) if (x?.extra) { delete x.extra.worldscrawl_location; delete x.extra.worldscrawl_world; }
        c.chat.push({ name: 'User', is_user: true, mes: 'hello while off', extra: {} }); await c.saveChat(); await c.eventSource.emit(c.eventTypes.CHAT_CHANGED); });
    await page.waitForTimeout(1500);
    check('off: chat load stamps nothing', await page.evaluate(() => { const e = SillyTavern.getContext().chat[0].extra ?? {}; return !e.worldscrawl_location && !e.worldscrawl_world; }));
    await toggle(true); await page.waitForTimeout(2000);
    check('on in a chat started while off: world + start stamped on the greeting', await page.evaluate(() => { const ch = SillyTavern.getContext().chat; const e = ch[0].extra ?? {};
        return e.worldscrawl_world?.id === 'riverton' && e.worldscrawl_location === 'riverton:drowned_rat/common_room' && !ch[1].extra?.worldscrawl_location; }));
    // Per chat: switching between an on chat and an off chat (metadata), defaults for old and new chats, /ws-on and /ws-off.
    const sw = async (md, strip = false) => { await page.evaluate(async ([md, strip]) => { const c = SillyTavern.getContext();
        if (md === undefined) delete c.chatMetadata.worldscrawl_enabled; else c.chatMetadata.worldscrawl_enabled = md;
        if (strip) { c.chat.splice(1); for (const x of [c.chat[0], ...(c.chat[0].swipe_info ?? [])]) if (x?.extra) for (const k of Object.keys(x.extra)) if (k.startsWith('worldscrawl')) delete x.extra[k]; }
        await c.eventSource.emit(c.eventTypes.CHAT_CHANGED); }, [md, strip]); await page.waitForTimeout(1500); };
    const st = () => page.evaluate(() => [document.getElementById('worldscrawl_enabled').checked, !!SillyTavern.getContext().extensionPrompts?.worldscrawl_facts?.value, document.querySelectorAll('#chat .worldscrawl_exits').length > 0]);
    await sw(false);
    check('switch to an off chat: unchecked, no world state, no footers', JSON.stringify(await st()) === '[false,false,false]', JSON.stringify(await st()));
    const wand = () => page.evaluate(() => document.querySelector('#extensionsMenu #worldscrawl_wand span')?.textContent);
    check('wand menu entry follows an off chat', (await wand()) === 'Enable WorldScrawl for this chat', String(await wand()));
    await page.evaluate(() => document.getElementById('worldscrawl_wand').click()); await page.waitForTimeout(1500);
    check('wand menu entry turns the chat on', (await wand()) === 'Disable WorldScrawl for this chat' && (await M(m => m.isOn())) === true && (await st())[0] === true);
    await sw(true);
    check('switch to an on chat: checked, world state and footers back, no reload', JSON.stringify(await st()) === '[true,true,true]', JSON.stringify(await st()));
    await page.evaluate(() => { const b = document.getElementById('worldscrawl_enable_new'); b.checked = false; b.dispatchEvent(new Event('change')); });
    await sw(undefined);
    check('old chat with stamps and no saved value defaults on', (await M(m => m.isOn())) === true && (await st())[0] === true);
    await sw(undefined, true);
    check('new chat (no stamps) follows the global default: off', (await M(m => m.isOn())) === false && JSON.stringify(await st()) === '[false,false,false]' && await page.evaluate(() => !SillyTavern.getContext().chat[0].extra?.worldscrawl_location));
    check('/ws-on works while off', (await page.evaluate(async () => (await SillyTavern.getContext().executeSlashCommandsWithOptions('/ws-on')).pipe)) === 'WorldScrawl is on in this chat.' && (await M(m => m.isOn())) === true);
    await page.waitForTimeout(1500);
    check('/ws-on stamped the fresh chat', await page.evaluate(() => SillyTavern.getContext().chat[0].extra?.worldscrawl_location === 'riverton:drowned_rat/common_room'));
    check('wand text follows /ws-on', (await wand()) === 'Disable WorldScrawl for this chat');
    check('/ws-off', (await page.evaluate(async () => (await SillyTavern.getContext().executeSlashCommandsWithOptions('/ws-off')).pipe)) === 'WorldScrawl is off in this chat.' && (await M(m => m.isOn())) === false && (await wand()) === 'Enable WorldScrawl for this chat');
    await page.evaluate(() => { const b = document.getElementById('worldscrawl_enable_new'); b.checked = true; b.dispatchEvent(new Event('change')); });
    await sw(undefined, true);
    check('new chat follows the global default: on', (await M(m => m.isOn())) === true && (await st())[0] === true && await page.evaluate(() => SillyTavern.getContext().chat[0].extra?.worldscrawl_location === 'riverton:drowned_rat/common_room'));
    // Readable world names: blank save = exactly the placeholder; typed name clash refused; slug clash gets -2.
    const worldsNow = async () => (await (await stFetch('/worlds')).json()).worlds;
    await page.evaluate(() => { const b = document.getElementById('worldscrawl_save_switch'); b.checked = false; document.getElementById('worldscrawl_save_name').value = ''; });
    const ph = await page.evaluate(() => document.getElementById('worldscrawl_save_name').placeholder);
    check('save placeholder is the readable default name', /^Riverton - .+ - [A-Z][a-z]{2} \d{1,2}, \d{1,2}:\d{2} [AP]M$/.test(ph), ph);
    await page.evaluate(() => document.getElementById('worldscrawl_save').click()); await page.waitForTimeout(2000);
    const autoW = (await worldsNow()).find(w => w.name === ph);
    check('blank save uses exactly the placeholder, readable slug', !!autoW && /^riverton-[a-z0-9-]+-[a-z]{3}-\d{1,2}$/.test(autoW.id) && (await lastMes()) === `[Engine: world saved as "${ph}".]`, JSON.stringify(autoW));
    check('world picker shows display names', await page.evaluate(n => [...document.querySelectorAll('#worldscrawl_world option')].some(o => o.textContent === n), ph));
    const nBefore = (await worldsNow()).length;
    await page.evaluate(() => SillyTavern.getContext().executeSlashCommandsWithOptions('/ws-save-world switch=false test world'));
    await page.waitForTimeout(1500);
    const tw0 = (await worldsNow()).find(w => w.name.toLowerCase() === 'test world');
    const res1 = await page.evaluate(async () => { const m = await import('/scripts/extensions/third-party/WorldScrawl/index.js'); return m.saveWorld('test world', false, false); });
    check('/ws-save-world over another living world refused without overwrite=true', res1.ok === false && /Add overwrite=true/.test(res1.error) && (await worldsNow()).length === nBefore, JSON.stringify(res1));
    await page.evaluate(() => SillyTavern.getContext().executeSlashCommandsWithOptions('/ws-save-world switch=false overwrite=true test world'));
    await page.waitForTimeout(1500);
    check('typed name matching an existing living save + overwrite=true saves over it (no new world)', (await worldsNow()).length === nBefore && !!tw0);
    // Panel Save asks in a popup instead (stubbed): No -> not saved; Yes -> saved over.
    for (const [ans, label] of [[0, 'declined popup: not saved'], [1, 'confirmed popup: saved over']]) {
        const res = await page.evaluate(async a => {
            const m = await import('/scripts/extensions/third-party/WorldScrawl/index.js'); const orig = m.hooks.confirm; let asked = null;
            m.hooks.confirm = async t => { asked = t; return !!a; };
            try { const r = await m.saveWorld('test world', false, false, { confirm: true }); return { ok: r.ok, asked }; }
            finally { m.hooks.confirm = orig; }
        }, ans);
        check('panel Save over another living world: ' + label, /Save over the world/.test(res.asked || '') && res.ok === !!ans && (await worldsNow()).length === nBefore, JSON.stringify(res));
    }
    await page.evaluate(() => SillyTavern.getContext().executeSlashCommandsWithOptions('/ws-save-world switch=false Test-World'));
    await page.waitForTimeout(1500);
    check('only the folder slug clashes: -2 added, name kept as typed', (await worldsNow()).some(w => w.id === 'test-world-2' && w.name === 'Test-World'));
    // Knarfy's sequence: blank save (switch on) -> dig both ways tunnel <-> common room -> save "My Riverton" -> pick it for
    // new chats -> start a real new chat: the passage must be there.
    await page.evaluate(() => { document.getElementById('worldscrawl_save_switch').checked = true; document.getElementById('worldscrawl_save_name').value = ''; });
    await page.evaluate(() => document.getElementById('worldscrawl_save').click()); await page.waitForTimeout(2000);
    const w1 = await M(m => m.chatWorld());
    check('repro: blank save with switch on rebases the chat', w1?.rebase && /^riverton-/.test(w1.id), JSON.stringify(w1));
    const pushLoc = a => page.evaluate(async a => { const c = SillyTavern.getContext(); c.chat.push({ name: 'User', is_user: true, mes: 'at ' + a, extra: { worldscrawl_location: a, worldscrawl_intent_checked: true } }); await c.saveChat(); }, a);
    await pushLoc('riverton:secret_tunnel/tunnel');
    await page.evaluate(() => SillyTavern.getContext().executeSlashCommandsWithOptions('/ws-dig oneway=true passage riverton:drowned_rat/common_room')); await page.waitForTimeout(1000);
    await pushLoc('riverton:drowned_rat/common_room');
    await page.evaluate(() => SillyTavern.getContext().executeSlashCommandsWithOptions('/ws-dig oneway=true passage riverton:secret_tunnel/tunnel')); await page.waitForTimeout(1000);
    check('repro: both digs recorded after the rebase', JSON.stringify(await M(m => m.chatChanges().map(c => c.from + '>' + c.to))) === JSON.stringify(['riverton:secret_tunnel/tunnel>riverton:drowned_rat/common_room', 'riverton:drowned_rat/common_room>riverton:secret_tunnel/tunnel']), JSON.stringify(await M(m => m.chatChanges())));
    await page.evaluate(() => { document.getElementById('worldscrawl_save_name').value = 'My Riverton'; });
    await page.evaluate(() => document.getElementById('worldscrawl_save').click()); await page.waitForTimeout(2000);
    const mr = (await worldsNow()).find(w => w.name === 'My Riverton');
    const room = async a => (await (await stFetch(`/location/${encodeURIComponent(a)}?world=${mr?.id}`)).json()).exits.map(e => e.direction + '>' + e.to);
    check('repro: saved world files have both dug exits', !!mr && (await room('riverton:secret_tunnel/tunnel')).includes('passage>riverton:drowned_rat/common_room') && (await room('riverton:drowned_rat/common_room')).includes('passage>riverton:secret_tunnel/tunnel'), JSON.stringify(mr));
    await page.evaluate(id => { const s = document.getElementById('worldscrawl_world'); s.value = id; s.dispatchEvent(new Event('change')); }, mr?.id);
    check('repro: picker selected the saved world', await page.evaluate(id => SillyTavern.getContext().extensionSettings.worldscrawl.world === id, mr?.id));
    apiUrls.length = 0;
    await page.evaluate(async () => { const s = await import('/script.js'); await s.doNewChat(); });
    await page.waitForTimeout(4000);
    const nc = await page.evaluate(() => { const ch = SillyTavern.getContext().chat; return { n: ch.length, w: ch[0]?.extra?.worldscrawl_world, loc: ch[0]?.extra?.worldscrawl_location }; });
    check('repro: new chat stamped with the picked world', nc.w?.id === mr?.id && nc.loc === 'riverton:drowned_rat/common_room', JSON.stringify(nc));
    check('repro: new chat requests use that world', apiUrls.some(u => u.includes(`world=${mr?.id}`)), JSON.stringify(apiUrls.slice(0, 8)));
    check('repro: cache keys include the world id', await page.evaluate(async id => { const m = await import('/scripts/extensions/third-party/WorldScrawl/index.js'); return m.cacheKeys().every(k => k.includes('|')) && m.cacheKeys().some(k => k.startsWith(id + '|')); }, mr?.id));
    check('repro: no request without a world once a chat is open', !apiUrls.filter(u => !u.includes('/worlds')).some(u => !u.includes('world=')), JSON.stringify(apiUrls.filter(u => !u.includes('world=')).slice(0, 4)));
    check('save dialog order: name, discoveries toggle + help, button, switch', await page.evaluate(() => { const ids = [...document.querySelectorAll('#worldscrawl_save_name, #worldscrawl_save_knowledge, #worldscrawl_save, #worldscrawl_save_switch')].map(e => e.id);
        return JSON.stringify(ids) === JSON.stringify(['worldscrawl_save_name', 'worldscrawl_save_knowledge', 'worldscrawl_save', 'worldscrawl_save_switch']) && document.getElementById('worldscrawl_save_knowledge').parentElement.textContent.includes("Include this chat's discoveries"); }));
    const ncEx = await wsExits();
    check('repro: dug passage shown in the new chat', ncEx.includes('passage'), ncEx);
    await page.evaluate(() => { const s = document.getElementById('worldscrawl_world'); s.value = ''; s.dispatchEvent(new Event('change')); });
    // Living saves: the save box offers the current living world's name; a blank save goes over it, always rebasing here.
    await page.evaluate(() => SillyTavern.getContext().executeSlashCommandsWithOptions('/ws-dig oneway=true hatch riverton:streets/square')); await page.waitForTimeout(1000);
    await page.evaluate(() => { document.getElementById('worldscrawl_save_switch').checked = false; const i = document.getElementById('worldscrawl_save_name'); i.value = ''; });
    await page.evaluate(() => document.querySelector('.worldscrawl_settings .inline-drawer-toggle').click()); await page.waitForTimeout(800);
    const ph2 = await page.evaluate(() => document.getElementById('worldscrawl_save_name').placeholder);
    check('living save: save box offers its own name', ph2 === 'My Riverton', ph2);
    const before3 = (await worldsNow()).length;
    await page.evaluate(() => document.getElementById('worldscrawl_save').click()); await page.waitForTimeout(2000);
    const ov = await M(m => ({ w: m.chatWorld(), ch: m.chatChanges().length }));
    check('save over the current world: rebase stamped even with switch off, no double replay', ov.w?.id === mr?.id && ov.w.rebase && ov.ch === 0 && (await worldsNow()).length === before3
        && (await lastMes()) === '[Engine: world "My Riverton" saved over its previous version.]', JSON.stringify(ov) + (await lastMes()));
    const hx = await wsExits();
    check('saved-over world: dug exit listed once and walkable', hx.split('hatch').length === 2, hx);
    await go('hatch');
    check('saved-over world: moving through the baked-in exit', (await stored()) === 'riverton:streets/square', String(await stored()));
    check('backup folder is never listed as a world', !(await worldsNow()).some(w => w.id.startsWith('.') || w.id === 'backups'));
    // Missing world: folder deleted while a chat is on it -> one notice, fallback to the world it was saved from, stamps untouched.
    await page.evaluate(() => { document.getElementById('worldscrawl_save_switch').checked = true; document.getElementById('worldscrawl_save_name').value = 'Doomed'; });
    await page.evaluate(() => document.getElementById('worldscrawl_save').click()); await page.waitForTimeout(2000);
    const doomed = (await worldsNow()).find(w => w.name === 'Doomed');
    check('missing world: setup on Doomed (saved from My Riverton)', (await M(m => m.chatWorld()?.id)) === doomed?.id && (await M(m => m.chatWorld()?.from)) === mr?.id);
    (await import('node:fs')).rmSync(`/tmp/ws-worlds/${doomed.id}`, { recursive: true, force: true });
    const emitCC = () => page.evaluate(async () => { const c = SillyTavern.getContext(); await c.eventSource.emit(c.eventTypes.CHAT_CHANGED); });
    await emitCC(); await page.waitForTimeout(2500);
    const mw = await page.evaluate(() => SillyTavern.getContext().chat.filter(m => m.extra?.worldscrawl_notice_kind === 'missing_world').map(m => m.mes));
    check('missing world: one notice, fallback to the world it was saved from', mw.length === 1 && mw[0].includes('"Doomed"') && mw[0].includes('Using "My Riverton"') && (await M(m => m.effectiveWorld())) === mr?.id, JSON.stringify(mw));
    check('missing world: stamps untouched, chat keeps working', (await M(m => m.chatWorld()?.id)) === doomed.id && (await stored()) === 'riverton:streets/square' && (await wsExits()).startsWith('Exits: in ('), String(await wsExits()));
    await emitCC(); await page.waitForTimeout(2000);
    check('missing world: notice only once', (await page.evaluate(() => SillyTavern.getContext().chat.filter(m => m.extra?.worldscrawl_notice_kind === 'missing_world').length)) === 1);
    const wb = await page.evaluate(() => [...document.querySelectorAll('#chat .worldscrawl_world_button')].map(b => b.dataset.world));
    check('missing world: picker buttons list existing worlds only', wb.includes('riverton') && !wb.includes(doomed.id), JSON.stringify(wb));
    await page.evaluate(() => document.querySelector('#chat .worldscrawl_world_button[data-world="riverton"]').click()); await page.waitForTimeout(2500);
    const mv3 = await M(m => ({ w: m.chatWorld(), e: m.effectiveWorld() }));
    check('missing world: picking a world rebases the chat onto it', mv3.w?.id === 'riverton' && mv3.w.rebase && mv3.e === 'riverton' && (await wsExits()).startsWith('Exits: in ('), JSON.stringify(mv3));
    await page.evaluate(id => { SillyTavern.getContext().extensionSettings.worldscrawl.world = id; }, doomed.id);
    await page.evaluate(() => jQuery('#worldscrawl_test').trigger('click')); await page.waitForTimeout(1500);
    check('deleted world dropped from the picker and the new-chats setting resets', await page.evaluate(id => SillyTavern.getContext().extensionSettings.worldscrawl.world === '' && ![...document.querySelectorAll('#worldscrawl_world option')].some(o => o.value === id), doomed.id));
    apiUrls.length = 0;
    await page.evaluate(() => document.getElementById('worldscrawl_open_folder').click()); await page.waitForTimeout(800);
    await page.evaluate(() => document.getElementById('worldscrawl_open_world').click()); await page.waitForTimeout(800);
    const of = apiUrls.filter(u => u.includes('/open-folder'));
    check('open folder buttons call the server with no path (root, then a world id)', of.length === 2 && !of[0].includes('world=') && /world=riverton$/.test(of[1]), JSON.stringify(of));
    check('open-folder refuses a path-like id', (await stFetch('/open-folder?world=..%2F..', { method: 'POST' })).status === 400);
    // ---- Narrative digging: "I smash out the window" -> new two-way exit, small validated questions, stamped on the player's message.
    await sw(true, true);
    await go('up');
    check('dig narrative: setup upstairs in the Drowned Rat', (await stored()) === 'riverton:drowned_rat/upstairs', String(await stored()));
    const near = (await (await stFetch('/nearby', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ from: 'riverton:drowned_rat/upstairs' }) })).json()).rooms;
    const sqN = near.findIndex(r => r.address === 'riverton:streets/square') + 1;
    check('nearby: rooms within 3 steps, nearest first, capped, Village Square included', sqN > 0 && near.length <= 12 && near[0].steps === 1 && near.every((r, i) => !i || near[i - 1].steps <= r.steps) && near.every(r => r.name && r.area && r.summary && !('exits' in r)), JSON.stringify(near.map(r => r.display_name)));
    const changesOfE = u => { const c = u.extra.worldscrawl_change; return Array.isArray(c) ? c : c ? [c] : []; };
    const lastU = () => page.evaluate(() => { const ch = SillyTavern.getContext().chat; for (let i = ch.length - 1; i >= 0; i--) if (ch[i].is_user) return { i, extra: ch[i].extra ?? {} }; return null; });
    const reqsNow = async () => (await fetch(`${FAKE}/__requests`)).json();
    const promptOf = r => JSON.stringify(r.messages ?? r);
    const bre = await M(m => ['I smash out the window', 'I eat breakfast', 'I go into the tunnel', 'there is a hole here', 'I punch through the wall', 'I make a hole in the floor', 'I kick down the door', 'the smashing pumpkins'].map(t => m.BREAK_RE.test(t)));
    check('break-word check: whole words and phrases only', JSON.stringify(bre) === '[true,false,false,false,true,true,true,true]', JSON.stringify(bre));
    // Breakfast: no breaking word, so no "new opening" option; a stray "new opening" answer goes the normal way (yes/no follow-up), never a dig.
    await queue([{ content: 'new opening' }, { content: 'no' }, { content: 'You eat.' }]);
    const rB = (await reqsNow()).length;
    await send('I eat breakfast', 3);
    const bq = (await reqsNow()).slice(rB);
    const luB = await lastU();
    check('breakfast: no new opening offered, stray answer handled normally', !promptOf(bq[0]).includes('new opening') && promptOf(bq[1]).includes('Answer yes or no') && !luB.extra.worldscrawl_change && !luB.extra.worldscrawl_dig_failed && (await stored()) === 'riverton:drowned_rat/upstairs', promptOf(bq[1]).slice(-200));
    // Guard: the model says "new opening" but the player only hits the wall -> no change.
    await queue([{ content: 'new opening' }, { content: 'no' }, { content: 'You punch the wall.' }]);
    await send('I punch the wall angrily', 3);
    let lu = await lastU();
    check('dig narrative: hitting a wall is not a breakthrough (no change, no follow-up questions)', !lu.extra.worldscrawl_change && !lu.extra.worldscrawl_dig_failed && (await stored()) === 'riverton:drowned_rat/upstairs', JSON.stringify(lu.extra));
    const r0 = (await reqsNow()).length;
    // Window -> Village Square; the first direction answer is taken ("down") and only that question is asked again.
    await queue([{ content: 'new opening' }, { content: String(sqN) }, { content: 'down' }, { content: 'Window' }, { content: 'no' }, { content: 'You land in the square in a shower of glass.' }]);
    await send('I run down the hall and leap through the window, breaking through the glass', 6);
    lu = await lastU();
    const rq = (await reqsNow()).slice(r0);
    const ch1 = lu.extra.worldscrawl_change;
    check('dig narrative: intent prompt offers the new opening choice', promptOf(rq[0]).includes('new opening: the player clearly breaks through'), promptOf(rq[0]).slice(0, 300));
    check('dig narrative: destination question is a numbered list of nearby places + somewhere new', promptOf(rq[1]).includes('Where does this opening most likely lead? Reply with just the number.') && promptOf(rq[1]).includes(`${sqN}. Village Square`) && promptOf(rq[1]).includes(`${near.length + 1}. somewhere new`), promptOf(rq[1]).slice(0, 600));
    check('dig narrative: invalid direction retried alone', promptOf(rq[2]).includes('What is the opening called from this side?') && promptOf(rq[3]).includes('What is the opening called from this side?') && rq.length === 6, String(rq.length));
    check('dig narrative: stay-on-this-side question asked', promptOf(rq[4]).includes('Does the player clearly stay on this side (only making the opening, looking or reaching through)? Reply yes or no.'), promptOf(rq[4]).slice(-300));
    check('dig narrative: two-way change stamped on the player message, return name "back"', ch1?.type === 'dig' && ch1.from === 'riverton:drowned_rat/upstairs' && ch1.to === 'riverton:streets/square' && ch1.direction === 'window' && ch1.return_direction === 'back' && lu.extra.worldscrawl_dig?.direction === 'window', JSON.stringify(lu.extra));
    check('dig narrative: party moved through the window to Village Square (move stamped on the same message)', (await stored()) === 'riverton:streets/square' && lu.extra.worldscrawl_location === 'riverton:streets/square' && lu.extra.worldscrawl_move?.direction === 'window' && (await wsExits()).includes('back (The Drowned Rat, Upstairs Rooms)'), await wsExits());
    check('dig narrative: narration told about breaking through and arriving', promptOf(rq[5]).includes('broke through, making a new opening (window) from Upstairs Rooms') && promptOf(rq[5]).includes('Narrate breaking through and arriving in Village Square'), promptOf(rq[5]).slice(-800));
    const back1 = await (await stFetch('/move', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ from: 'riverton:streets/square', direction: 'back', changes: await M(m => m.chatChanges()) }) })).json();
    check('dig narrative: the square has the way back', back1.address === 'riverton:drowned_rat/upstairs', JSON.stringify(back1).slice(0, 200));
    // Swipe the reply: the change stays (it lives on the player's message, like a move).
    await queue([{ content: 'Another take on the glass.' }]); expected += 1;
    await page.evaluate(() => jQuery('#chat .last_mes .swipe_right').trigger('click')); await waitReqs();
    const sw1 = await lastU();
    check('dig narrative: swiping the reply keeps the change and the move', sw1.i === lu.i && sw1.extra.worldscrawl_change?.direction === 'window' && (await stored()) === 'riverton:streets/square' && (await wsExits()).includes('back (The Drowned Rat, Upstairs Rooms)'), await wsExits());
    // Delete the player's message: the change is gone.
    await page.evaluate(async i => { const c = SillyTavern.getContext(); await c.executeSlashCommandsWithOptions(`/cut ${i}-${c.chat.length - 1}`); }, lu.i); await page.waitForTimeout(1500);
    check('dig narrative: deleting the message undoes the dig and the move', (await stored()) === 'riverton:drowned_rat/upstairs' && !(await wsExits()).includes('window') && (await M(m => m.chatChanges().length)) === 0, await wsExits());
    // "...and peer through": the go-through answer is no -> dig only, the party stays.
    await queue([{ content: 'new opening' }, { content: String(sqN) }, { content: 'hole' }, { content: 'yes' }, { content: 'You peer through.' }]);
    await send('I smash a hole in the wall and peer through', 5);
    lu = await lastU();
    check('dig narrative: "peer through" (clean yes to staying) -> dig, no move', lu.extra.worldscrawl_change?.direction === 'hole' && !lu.extra.worldscrawl_move && (await stored()) === 'riverton:drowned_rat/upstairs' && (await wsExits()).includes('hole (Village Square') && promptOf(await lastReq()).includes('broke through, making a new opening (hole) from here'), await wsExits());
    await page.evaluate(async i => { const c = SillyTavern.getContext(); await c.executeSlashCommandsWithOptions(`/cut ${i}-${c.chat.length - 1}`); }, lu.i); await page.waitForTimeout(1500);
    // Somewhere new: name + description questions, new room in this building, walkable both ways.
    await queue([{ content: 'new opening' }, { content: String(near.length + 1) }, { content: 'the hole' }, { content: 'dusty crawl space' }, { content: 'A cramped crawlspace full of cobwebs' }, { content: 'maybe' }, { content: 'You climb down.' }]);
    await send('I bash a hole through the floorboards', 7);
    lu = await lastU();
    const ch2 = lu.extra.worldscrawl_change;
    check('dig narrative: new room change (add_room + dig) in the current subregion', Array.isArray(ch2) && ch2[0].type === 'add_room' && ch2[0].address.startsWith('riverton:drowned_rat/dusty_crawl_space_') && ch2[0].name === 'Dusty Crawl Space' && ch2[0].description === 'A cramped crawlspace full of cobwebs.' && ch2[1].type === 'dig' && ch2[1].direction === 'hole' && ch2[1].return_direction === 'back', JSON.stringify(ch2));
    check('dig narrative: unclear stay answer -> goes through, party ends in the new room; narration gets its description', (await stored()) === ch2?.[0]?.address && promptOf(await lastReq()).includes('This location: A cramped crawlspace full of cobwebs.'), String(await stored()));
    check('dig narrative: in the new room; its way back listed', (await stored()) === ch2?.[0]?.address && (await wsExits()) === 'Exits: back (Upstairs Rooms)', await wsExits());
    await go('back');
    // Failure: unreadable destination twice -> no change, a notice, narration says nothing gave way.
    await queue([{ content: 'new opening' }, { content: 'banana' }, { content: 'the moon' }, { content: 'You strain.' }]);
    await send('I smash the wall with my fist until it breaks', 4);
    lu = await lastU();
    check('dig narrative: failed validation -> no change, narrated as failed', !lu.extra.worldscrawl_change && lu.extra.worldscrawl_dig_failed === true && promptOf(await lastReq()).includes('nothing gave way'), JSON.stringify(lu.extra));
    // /ws-dig: two-way by default with dir/returndir, refused when either side has that name, new room, one-way.
    const dig = async t => { await page.evaluate(t => SillyTavern.getContext().executeSlashCommandsWithOptions(t), t); await page.waitForTimeout(1000); };
    const nBefore2 = await M(m => m.chatChanges().length);
    await dig('/ws-dig down Village Square');
    check('/ws-dig refused: exit name already here', (await M(m => m.chatChanges().length)) === nBefore2);
    await dig('/ws-dig crack/gap Village Square');
    check('/ws-dig two-way with dir/returndir', (await lastMes()) === '[Engine: a passage crack to Village Square was opened (back: gap).]', await lastMes());
    await dig('/ws-dig crevice/gap Village Square');
    check('/ws-dig refused: return name already on the far side', (await M(m => m.chatChanges().length)) === nBefore2 + 1);
    await dig('/ws-dig north Common Room');
    check('/ws-dig compass return name is the opposite', (await M(m => m.chatChanges().at(-1)?.return_direction)) === 'south');
    await dig('/ws-dig nook new Little Nook: A tiny nook.');
    check('/ws-dig new room', (await wsExits()).includes('nook (Little Nook)') && (await lastMes()) === '[Engine: a passage nook to Little Nook was opened (back: back).]', await wsExits());
    await dig('/ws-dig oneway=true chute Village Square');
    check('/ws-dig oneway=true', (await M(m => m.chatChanges().at(-1)?.type)) === 'add_exit' && (await lastMes()) === '[Engine: a passage chute to Village Square was opened.]', await lastMes());
    // ---- Looking: the upstairs window (no exit) -> a nearby place, stamped as a view link, same answer next time.
    await sw(true, true);
    await go('up');
    const nearUp = (await (await stFetch('/nearby', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ from: 'riverton:drowned_rat/upstairs' }) })).json()).rooms;
    const sqU = nearUp.findIndex(r => r.address === 'riverton:streets/square') + 1;
    let rL = (await reqsNow()).length;
    await queue([{ content: 'look' }, { content: '3' }, { content: String(sqU) }, { content: 'Below, the square bustles.' }]);
    await send('I look out the window', 4);
    let lq = (await reqsNow()).slice(rL), lk = await lastU();
    check('look: intent offers look; target list has the exits plus a window', promptOf(lq[0]).includes('- look: the player looks, peers, peeks or listens') && promptOf(lq[1]).includes('1. around here in general, nothing specific') && promptOf(lq[1]).includes('2. the down exit (to Common Room)') && promptOf(lq[1]).includes('3. out a window or opening with no exit'), promptOf(lq[1]).slice(-400));
    check('look: window view picked from the nearby list and stamped as a view link', promptOf(lq[2]).includes('Which place can they most likely see? Reply with just the number.') && JSON.stringify(lk.extra.worldscrawl_change) === JSON.stringify([{ type: 'view_link', from: 'riverton:drowned_rat/upstairs', to: 'riverton:streets/square' }]), JSON.stringify(lk.extra));
    check('look: narration sees the square, party stays', promptOf(lq[3]).includes('looks out and sees Village Square') && promptOf(lq[3]).includes('Visible from here (no way through): Village Square') && (await stored()) === 'riverton:drowned_rat/upstairs', promptOf(lq[3]).slice(-900));
    rL = (await reqsNow()).length;
    await queue([{ content: 'look' }, { content: '3' }, { content: 'The square again.' }]);
    await send('I glance out the window again', 3);
    lq = (await reqsNow()).slice(rL); lk = await lastU();
    check('look: second look reuses the view link (no question, no new stamp)', lq.length === 3 && !lk.extra.worldscrawl_change && lk.extra.worldscrawl_look?.to === 'riverton:streets/square', JSON.stringify(lk.extra));
    // Look-only message: no move options, so "out" in "I look out the door" can't move the party (model answers "out" anyway).
    await go('down');
    rL = (await reqsNow()).length;
    await queue([{ content: 'out' }, { content: 'You eye the door.' }]);
    await send('I look out the door', 2);
    lq = (await reqsNow()).slice(rL); lk = await lastU();
    check('look out the door: no move options offered, party stays', !promptOf(lq[0]).includes('the player goes through the') && !promptOf(lq[0]).includes('- elsewhere:') && (await stored()) === 'riverton:drowned_rat/common_room' && !lk.extra.worldscrawl_move, promptOf(lq[0]).slice(-700));
    check('stay-put narration: still in the room, no leaving/arriving', promptOf(lq.at(-1)).includes('User has NOT moved this turn and is still at Common Room (The Drowned Rat). No move happened: do not describe User leaving'), promptOf(lq.at(-1)).slice(-700));
    rL = (await reqsNow()).length;
    await queue([{ content: 'out' }, { content: 'You step out.' }]);
    await send('I go out', 2);
    lq = (await reqsNow()).slice(rL);
    check('I go out: move options offered and the party moves', promptOf(lq[0]).includes('- out: the player goes through the') && (await stored()) === 'riverton:streets/square', String(await stored()));
    // ---- Doors, in a test world: front door closed (Drowned Rat doors shut themselves), temple stays open (region), square east door: exit override.
    const fsD = await import('node:fs');
    fsD.cpSync('/tmp/ws-worlds/riverton', '/tmp/ws-worlds/doorsworld', { recursive: true });
    const rp = '/tmp/ws-worlds/doorsworld/regions/riverton.json', rj = JSON.parse(fsD.readFileSync(rp, 'utf8'));
    const exD = (sub, loc, d) => rj.subregions[sub].locations[loc].exits.find(e => e.direction === d);
    rj.stays_open = true; rj.subregions.drowned_rat.stays_open = false;
    Object.assign(exD('drowned_rat', 'common_room', 'out'), { view: 'closed' }); Object.assign(exD('streets', 'square', 'in'), { view: 'closed' });
    Object.assign(exD('temple', 'nave', 'south'), { view: 'closed' }); Object.assign(exD('streets', 'square', 'east'), { view: 'closed', stays_open: false });
    fsD.writeFileSync(rp, JSON.stringify(rj, null, 2));
    fsD.writeFileSync('/tmp/ws-worlds/doorsworld/world.json', JSON.stringify({ name: 'Doors World', start_region: 'riverton', living: false, weather_regions: { riverside: { climate: 'temperate' } } }));
    await (await stFetch('/worlds')).json(); // rescan
    await page.evaluate(() => { SillyTavern.getContext().extensionSettings.worldscrawl.world = 'doorsworld'; });
    await sw(true, true);
    check('doors: chat on the test world', (await M(m => m.effectiveWorld())) === 'doorsworld' && (await stored()) === 'riverton:drowned_rat/common_room', String(await M(m => m.effectiveWorld())));
    const openDoors = () => M(m => [...m.doorStates().values()].map(c => `${c.from.split('/')[1]}|${c.direction}`).sort().join(','));
    // 'I look around': no target question, no view link, normal look-around narration.
    rL = (await reqsNow()).length;
    await queue([{ content: 'look' }, { content: 'You take in the room.' }]);
    await send('I look around', 2);
    lq = (await reqsNow()).slice(rL); lk = await lastU();
    check('look around: no target question, no view_link, kind around', lq.length === 2 && !lk.extra.worldscrawl_change && lk.extra.worldscrawl_look?.kind === 'around' && !lq.some(q => promptOf(q).includes('What is the player looking at')), JSON.stringify(lk.extra) + lq.length);
    check('look around: narration uses look-around + exits hint', promptOf(lq[1]).includes('looks around') && promptOf(lq[1]).includes('mention every exit listed above') && !promptOf(lq[1]).includes('looks out and sees'), promptOf(lq[1]).slice(-600));
    // Ambiguous look: option 1 = around; no window option without window words (and no views here).
    rL = (await reqsNow()).length;
    await queue([{ content: 'look' }, { content: '1' }, { content: 'The room, in general.' }]);
    await send('I look at things for a while', 3);
    lq = (await reqsNow()).slice(rL); lk = await lastU();
    check('look: option 1 (around) gives kind around, no stamp', lk.extra.worldscrawl_look?.kind === 'around' && !lk.extra.worldscrawl_change && promptOf(lq[1]).includes('1. around here in general, nothing specific') && promptOf(lq[2]).includes('mention every exit listed above'), JSON.stringify(lk.extra));
    check('look: window option absent without window words', !promptOf(lq[1]).includes('out a window or opening'), promptOf(lq[1]).slice(-400));
    rL = (await reqsNow()).length;
    await queue([{ content: 'look' }, { content: '2' }, { content: '2' }, { content: 'You peek outside.' }]);
    await send('I peek through the keyhole of the front door', 4);
    lq = (await reqsNow()).slice(rL); lk = await lastU();
    check('doors: closed-door question offers listen / peek / open / just looking', ['1. only listens', '2. peeks through it', '3. opens it', '4. just looks at the closed door'].every(x => promptOf(lq[2]).includes(x)), promptOf(lq[2]).slice(-400));
    check('doors: peek shows the room beyond but leaves the door shut, stamps a peek record', lk.extra.worldscrawl_look?.kind === 'see' && lk.extra.worldscrawl_look.peek === true && !lk.extra.worldscrawl_change && lk.extra.worldscrawl_peek?.type === 'peek' && lk.extra.worldscrawl_peek.door === 'out' && lk.extra.worldscrawl_peek.from === 'riverton:drowned_rat/common_room' && (await openDoors()) === '' && promptOf(lq[3]).includes('peeks through the closed door (out) without opening it') && promptOf(lq[3]).includes('The door stays closed'), JSON.stringify(lk.extra) + promptOf(lq[3]).slice(-400));
    rL = (await reqsNow()).length;
    await queue([{ content: 'look' }, { content: '2' }, { content: '4' }, { content: 'A sturdy door.' }]);
    await send('I look at the front door', 4);
    lq = (await reqsNow()).slice(rL); lk = await lastU();
    check('doors: just looking at a closed door: "the door is closed", nothing opened or peeked', lk.extra.worldscrawl_look?.kind === 'closed' && !lk.extra.worldscrawl_change && !lk.extra.worldscrawl_peek && (await openDoors()) === '' && promptOf(lq[3]).includes('The door is closed; nothing beyond it can be seen') && !promptOf(lq[3]).includes('sees Village Square'), JSON.stringify(lk.extra) + promptOf(lq[3]).slice(-400));
    rL = (await reqsNow()).length;
    await queue([{ content: 'look' }, { content: '2' }, { content: '3' }, { content: 'You open it and look outside.' }]);
    await send('I open the front door and look outside', 4);
    lq = (await reqsNow()).slice(rL); lk = await lastU();
    check('doors: opening a closed door to look stamps open_door and shows the room beyond', changesOfE(lk)[0]?.type === 'open_door' && changesOfE(lk)[0].direction === 'out' && changesOfE(lk)[0].stays_open === false && !lk.extra.worldscrawl_peek && promptOf(lq[3]).includes('opens the door (out) first') && promptOf(lq[3]).includes('sees Village Square') && promptOf(lq[3]).includes('Looking out, you can see Village Square: '), JSON.stringify(lk.extra) + promptOf(lq[3]).slice(-600));
    check('glimpse wording: direction words vs nouns', JSON.stringify(await M(m => m.glimpseLines({ exits: [{ direction: 'up', view: 'open', to: 'a', to_name: 'Attic', to_summary: 'Dusty.' }, { direction: 'gate', view: 'open', to: 'b', to_name: 'Yard', to_summary: 'Muddy.' }] }))) === JSON.stringify(['Looking up, you can see Attic: Dusty.', 'Through the gate, you can see Yard: Muddy.']));
    check('doors: open door listed', (await openDoors()) === 'common_room|out', await openDoors());
    await go('out');
    check('doors: still open while in one of its rooms', (await openDoors()) === 'common_room|out', await openDoors());
    await go('north');
    check('doors: front door shut itself after leaving both rooms', (await openDoors()) === '', await openDoors());
    await page.evaluate(() => SillyTavern.getContext().executeSlashCommandsWithOptions('/ws-open south')); await page.waitForTimeout(1000);
    await go('south', 'west');
    check('doors: temple door stays open (region stays_open, subregion silent)', (await openDoors()) === 'nave|south', await openDoors());
    { const t = await M(m => m.lookText('Ann', 'East Road', { kind: 'threshold', via: 'east', description: 'The road runs on east and out of sight.', unknown: false, name: 'Larkspur' }));
      check('long road (sight none, not obscured): look describes the road, may name Larkspur, not describe it', t.includes('The road runs on east and out of sight.') && t.includes('It leads to Larkspur, but that cannot be seen') && t.includes('do not describe what lies at the far end') && !t.includes('nothing can be made out'), t); }
    await go('east');
    await page.evaluate(() => SillyTavern.getContext().executeSlashCommandsWithOptions('/ws-open east')); await page.waitForTimeout(1000);
    await go('west');
    check('doors: exit-level stays_open=false beats the region', (await openDoors()) === 'nave|south', await openDoors());
    await go('east');
    await page.evaluate(() => SillyTavern.getContext().executeSlashCommandsWithOptions('/ws-close north')); await page.waitForTimeout(1000);
    check('doors: explicit close from the other side', (await openDoors()) === '', await openDoors());
    rL = (await reqsNow()).length;
    await queue([{ content: 'look' }, { content: '2' }, { content: '1' }, { content: 'Muffled voices.' }]);
    await send('I listen at the tavern door', 4);
    lq = (await reqsNow()).slice(rL); lk = await lastU();
    check('doors: listening at a closed door: faint hint only, nothing opened', lk.extra.worldscrawl_look?.kind === 'listen' && !lk.extra.worldscrawl_change && promptOf(lq[3]).includes('Only faint, muffled sounds') && !promptOf(lq[3]).includes('Looking in, you can see'), promptOf(lq[3]).slice(-500));
    // Obscured trapdoor: both rooms recorded (opaque tokens), so it stays open in the cellar and shuts once both are left.
    await go('in', 'back');
    rL = (await reqsNow()).length;
    await queue([{ content: 'look' }, { content: '5' }, { content: '4' }, { content: 'A stair into the dark.' }]);
    await send('I look at the trapdoor', 4);
    lq = (await reqsNow()).slice(rL); lk = await lastU();
    check('obscured trapdoor: looking at it injects its near-side description and says where it leads is unknown (not revealed, not "nothing")', lq.length === 4 && lk.extra.worldscrawl_look?.kind === 'threshold' && lk.extra.worldscrawl_look.unknown === true && promptOf(lq[3]).includes('heavy cellar door set into the flagstones') && promptOf(lq[3]).includes('Where it leads is not clear and is unknown') && !promptOf(lq[3]).includes('Cellar (') && !promptOf(lq[3]).includes('ale casks') && !promptOf(lq[3]).includes('nothing can be made out') && !lk.extra.worldscrawl_change, JSON.stringify(lk.extra) + promptOf(lq[3]).slice(-600));
    await page.evaluate(() => SillyTavern.getContext().executeSlashCommandsWithOptions('/ws-open trapdoor')); await page.waitForTimeout(1000);
    const trapCh = await page.evaluate(() => { const ch = SillyTavern.getContext().chat; return ch[ch.length - 1].extra.worldscrawl_change; });
    check('doors: opening an obscured door records both rooms as opaque tokens', trapCh?.rooms?.length === 2 && trapCh.rooms.every(r => r.startsWith('room_')) && !JSON.stringify(trapCh).includes('cellar'), JSON.stringify(trapCh));
    await go('trapdoor');
    check('doors: trapdoor still open from the cellar side', (await stored()) === 'riverton:drowned_rat/cellar' && (await openDoors()) === 'courtyard|trapdoor', await openDoors());
    await go('trapdoor', 'in');
    check('doors: trapdoor shut after leaving both rooms', (await openDoors()) === '', await openDoors());
    // ---- /ws-known: been there vs seen, readable names, no hidden destinations.
    const kn2 = await page.evaluate(async () => (await SillyTavern.getContext().executeSlashCommandsWithOptions('/ws-known')).pipe);
    check('/ws-known lists been-there and seen places by name', /^Been there: .*Common Room.*\. Seen: /.test(kn2) && !/riverton:/.test(kn2), kn2);
    check('/ws-known never names a hidden destination', !/Cellar/.test(kn2.split('Seen:')[1] ?? '') || kn2.split('Been there:')[1].split('Seen:')[0].includes('Cellar'), kn2);
    // ---- Exits hint only on arrival / look-around; obscured exits stay label-only.
    const exH = await M(m => { const loc = { name: 'Hall', description: 'A hall.', exits: [{ direction: 'north', view: 'open', to: 'r:a', to_name: 'Yard', to_summary: 'Muddy.' }, { direction: 'trapdoor', obscured: true, to: 'r:b', to_name: 'Vault', to_summary: 'Gold.' }] };
        return { arrive: m.factsText({ ...loc, address: 'r:h' }, { direction: 'south', from_name: 'X', to_name: 'Hall', to: 'r:h' }, false), around: m.factsText(loc, null, false, { lookAround: true }), plain: m.factsText(loc, null, false), re: ['I look around', 'she glances about the room', 'I survey the surroundings', 'I look at the door'].map(x => m.LOOK_AROUND_RE.test(x)) }; });
    check('narration: exits hint on arrival and on look-around only', exH.arrive.includes('mention every exit') && exH.around.includes('mention every exit') && exH.around.includes('looks around') && !exH.plain.includes('mention every exit'), JSON.stringify(exH).slice(0, 600));
    check('narration: obscured exit label-only, no guessing invited', !exH.arrive.includes('Vault') && exH.arrive.includes('do not hint or guess where it leads') && exH.arrive.includes('you can see Yard'), exH.arrive);
    check('look-around phrase detection', JSON.stringify(exH.re) === '[true,true,true,false]', JSON.stringify(exH.re));
    const sm = await M(m => { const a = [{ mes: 'Hi. [ws-start]' }, { mes: 'x' }]; const orig = a[0]; m.stripStartMarker(a); return { p: a[0].mes, o: orig.mes }; });
    check('[ws-start] marker stripped from the prompt copy, stored text kept', sm.p === 'Hi.' && sm.o === 'Hi. [ws-start]', JSON.stringify(sm));
    // ---- [ws-start] greeting button.
    await page.evaluate(() => SillyTavern.getContext().executeSlashCommandsWithOptions('/newchat'));
    await page.waitForTimeout(3000);
    await page.evaluate(async () => { const c = SillyTavern.getContext(); c.chat[0].mes = 'Welcome, traveler. [ws-start]'; if (c.chat[0].swipes) c.chat[0].swipes[c.chat[0].swipe_id ?? 0] = c.chat[0].mes; await c.saveChat(); await c.reloadCurrentChat(); });
    await page.waitForTimeout(3000);
    const g0 = await page.evaluate(() => ({ btn: document.querySelectorAll('#chat .mes[mesid="0"] .worldscrawl_start_button').length, txt: document.querySelector('#chat .mes[mesid="0"] .mes_text').textContent, mes: SillyTavern.getContext().chat[0].mes }));
    check('[ws-start] renders a Start your adventure button, marker hidden, stored text untouched', g0.btn === 1 && !g0.txt.includes('[ws-start]') && g0.txt.includes('Start your adventure') && g0.mes === 'Welcome, traveler. [ws-start]', JSON.stringify(g0));
    const rS = (await reqsNow()).length;
    await queue([{ content: 'stay' }, { content: 'You look around the tavern.' }, { content: 'You look around the tavern.' }]);
    await page.click('#chat .worldscrawl_start_button');
    for (let i = 0; i < 40 && (await page.evaluate(() => SillyTavern.getContext().chat.length)) < 3; i++) await page.waitForTimeout(500);
    await page.waitForFunction(() => !jQuery('#mes_stop').is(':visible'), null, { timeout: 30000 }); await page.waitForTimeout(2000);
    expected = (await reqsNow()).length;
    const stS = await page.evaluate(() => { const c = SillyTavern.getContext(); return { u: c.chat[1]?.is_user && c.chat[1].mes, loc: c.chat.some((m, i) => i > 0 && m.extra?.worldscrawl_location), btn: document.querySelectorAll('#chat .worldscrawl_start_button').length, mes0: c.chat[0].mes }; });
    check('start button sends "I look around" through the normal path', stS.u === "I look around" && (await reqsNow()).length > rS, JSON.stringify(stS));
    check('start button gone once the chat has more than the greeting', stS.btn === 0 && stS.mes0 === 'Welcome, traveler. [ws-start]', JSON.stringify(stS));
    await page.evaluate(async () => { const c = SillyTavern.getContext(); c.chat.splice(1); await c.saveChat(); await c.eventSource.emit(c.eventTypes.MESSAGE_DELETED, 1); });
    await page.waitForTimeout(1000);
    check('start button comes back after deleting down to the greeting', await page.locator('#chat .worldscrawl_start_button').count() === 1);
    const sentMarker = (await reqsNow()).some(r => JSON.stringify(r.messages ?? r.prompt ?? '').includes('[ws-start]'));
    check('model never saw the [ws-start] marker', !sentMarker);
    await page.evaluate(() => SillyTavern.getContext().executeSlashCommandsWithOptions('/ws-off')); await page.waitForTimeout(1000);
    check('no start button when WorldScrawl is off in the chat', await page.locator('#chat .worldscrawl_start_button').count() === 0 && await page.evaluate(() => SillyTavern.getContext().chat[0].mes === 'Welcome, traveler. [ws-start]'));
    // ---- The WorldScrawl window (plugin/ui/): served by the plugin, follows the chat over BroadcastChannel.
    const ui = await page.context().newPage(); await ui.setViewportSize({ width: 1200, height: 800 });
    const uiErrors = []; ui.on('pageerror', e => { uiErrors.push(e.message); console.log('[ui pageerror]', e.message); });
    const uiRes = await ui.goto(BASE + 'api/plugins/worldscrawl/ui/');
    check('map window page is served', uiRes.status() === 200 && /WorldScrawl/.test(await ui.title()), String(uiRes.status()));
    await ui.waitForTimeout(2500);
    check('map window: friendly message when the chat has WorldScrawl off', /Open a chat with WorldScrawl on/.test(await ui.locator('#windows').innerText()));
    await page.evaluate(() => SillyTavern.getContext().executeSlashCommandsWithOptions('/ws-on'));
    try { await ui.waitForSelector('.node.here', { timeout: 15000 }); } catch {}
    const m1 = await ui.evaluate(() => ({ here: document.querySelector('.node.here')?.dataset.id, ids: [...document.querySelectorAll('.node')].map(n => n.dataset.id), side: document.querySelector('.side')?.innerText ?? '', btn: document.querySelector('[data-window="map"]')?.className }));
    check('map window receives the broadcast and highlights the current room', m1.here === 'riverton:drowned_rat/common_room' && /Common Room/.test(m1.side) && /active/.test(m1.btn), JSON.stringify(m1).slice(0, 400));
    check('map window shows no hidden place', !m1.ids.some(i => /cellar|tunnel|catacomb/.test(i)), JSON.stringify(m1.ids));
    const themed = await ui.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--SmartThemeBodyColor').trim());
    const stTheme = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--SmartThemeBodyColor').trim());
    check('map window uses SillyTavern theme colours', !!themed && themed === stTheme, `${themed} vs ${stTheme}`);
    await page.evaluate(() => SillyTavern.getContext().executeSlashCommandsWithOptions('/ws-go up'));
    try { await ui.waitForFunction(() => document.querySelector('.node.here')?.dataset.id !== 'riverton:drowned_rat/common_room', null, { timeout: 15000 }); } catch {}
    const m2 = await ui.evaluate(() => ({ here: document.querySelector('.node.here')?.dataset.id, stood: [...document.querySelectorAll('.node.stood')].map(n => n.dataset.id) }));
    check('map window follows a move live', m2.here && m2.here !== 'riverton:drowned_rat/common_room' && m2.stood.includes('riverton:drowned_rat/common_room'), JSON.stringify(m2));
    await ui.screenshot({ path: '/tmp/ws-e2e-map.png' });
    // Layers: opens on the current room's subregion; breadcrumb goes up; double-click drills down.
    const nodeIds = () => ui.evaluate(() => [...document.querySelectorAll('.node')].map(n => n.dataset.id));
    const crumbText = () => ui.evaluate(() => [...document.querySelectorAll('#breadcrumb .crumb')].map(c => c.textContent));
    check('map opens on the current room\'s area, with a breadcrumb', JSON.stringify(await crumbText()) === JSON.stringify(['World', 'Riverton', 'The Drowned Rat']), JSON.stringify(await crumbText()));
    await ui.click('#breadcrumb .crumb[data-level="region"]'); await ui.waitForTimeout(300);
    const rIds = await nodeIds();
    const rHere = await ui.evaluate(() => document.querySelector('.node.here')?.dataset.id);
    check('region layer: one node per discovered area, current area highlighted, nothing undiscovered', rIds.includes('sub:riverton:drowned_rat') && rIds.includes('sub:riverton:streets') && rHere === 'sub:riverton:drowned_rat'
        && !rIds.some(i => /temple|docks|secret|smithy|general_store|gilded/.test(i)) && rIds.every(i => i.startsWith('sub:riverton:')), JSON.stringify(rIds));
    await ui.screenshot({ path: '/tmp/ws-e2e-map-region.png' });
    await ui.click('#breadcrumb .crumb[data-level="world"]'); await ui.waitForTimeout(300);
    check('world layer: one node per region', JSON.stringify(await nodeIds()) === '["region:riverton"]', JSON.stringify(await nodeIds()));
    await ui.dblclick('.node[data-id="region:riverton"]'); await ui.waitForTimeout(300);
    await ui.dblclick('.node[data-id="sub:riverton:drowned_rat"]'); await ui.waitForTimeout(300);
    const dIds = await nodeIds();
    check('double-click drills down to the rooms', dIds.includes('riverton:drowned_rat/upstairs') && (await crumbText()).length === 3, JSON.stringify(dIds));
    await ui.click('#breadcrumb .crumb[data-level="region"]'); await ui.waitForTimeout(300);
    await ui.click('.mapbuttons .topbutton'); await ui.waitForTimeout(300);
    check('Centre goes back to the current room\'s layer', (await ui.evaluate(() => document.querySelector('.node.here')?.dataset.id)) === m2.here);
    check('map window raised no page errors', uiErrors.length === 0, JSON.stringify(uiErrors));
    await ui.close();
    const popup = page.waitForEvent('popup', { timeout: 10000 }).catch(() => null);
    await page.evaluate(() => SillyTavern.getContext().executeSlashCommandsWithOptions('/ws-map'));
    const pop = await popup; if (pop) await pop.waitForURL(/worldscrawl\/ui\//, { timeout: 10000 }).catch(() => {});
    check('/ws-map opens the map window', !!pop && /\/api\/plugins\/worldscrawl\/ui\/$/.test(pop.url()), pop?.url());
    await pop?.close();
    check('settings panel has an Open map window button', await page.locator('#worldscrawl_open_map').count() === 1);
    await page.evaluate(() => { SillyTavern.getContext().extensionSettings.worldscrawl.world = ''; });
    await page.screenshot({ path: '/tmp/ws-e2e.png' });
} finally {
    await browser.close();
}
console.log(failures ? `${failures} FAILED` : 'ALL PASSED');
process.exit(failures ? 1 : 0);
