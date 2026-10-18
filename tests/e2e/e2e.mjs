import { chromium } from 'playwright-core';
const BASE = 'http://localhost:8767/';
const FAKE = 'http://127.0.0.1:9098';
let failures = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}: ${name} ${extra}`); if (!ok) failures++; };
const queue = q => fetch(`${FAKE}/__queue`, { method: 'POST', body: JSON.stringify(q) });

const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'], headless: true });
try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    page.on('console', m => { if (m.type() === 'error' || /WorldScrawl/.test(m.text())) console.log('[console]', m.type(), m.text().slice(0, 300)); });
    const apiCalls = [];
    const typedGets = []; // GETs to the map server that carry a Content-Type (would force a CORS preflight)
    page.on('request', r => { const u = r.url(); if (!u.includes(':5199/')) return; apiCalls.push(decodeURIComponent(new URL(u).pathname)); if (r.method() === 'GET' && r.headers()['content-type']) typedGets.push(u); });
    page.on('pageerror', e => console.log('[pageerror]', e.message));
    await page.goto(BASE);
    await page.waitForSelector('#send_textarea', { timeout: 90000 });
    const ok = page.locator('dialog[open] .popup-button-ok').first();
    try { await ok.waitFor({ timeout: 8000 }); await ok.click(); } catch {}
    await page.waitForTimeout(1500);

    await page.waitForSelector('input[name="worldscrawl_mode"]', { state: 'attached', timeout: 60000 });
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
    await page.evaluate(() => { const c = SillyTavern.getContext(); c.extensionSettings.worldscrawl.serverUrl = 'http://127.0.0.1:5199'; });
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
    const squareStub = u => u.href.includes('/location/riverton%3Astreets%2Fsquare') || u.href.includes(':5199/rooms');
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
        const get = async a => (await fetch('http://127.0.0.1:5199/location/' + encodeURIComponent(a))).json();
        return [m.exitsText(await get('riverton:streets/market_lane')), m.exitsText(await get('riverton:drowned_rat/courtyard')), m.exitsText({ exits: [{ direction: 'crack', hidden: true }] })]; });
    check('exit labels: building on entrance, building + room otherwise, room within the building, hidden = label only',
        bl[0] === "Exits: east (Village Square), inn (The Gilded Goose), store (Marlow's General Store), smithy (Brask's Smithy), gate (The Drowned Rat, Stable)"
        && bl[1] === 'Exits: in (Common Room), kitchen, stable, trapdoor' && bl[2] === 'Exits: crack', JSON.stringify(bl));
    const mn = await page.evaluate(async () => { const m = await import('/scripts/extensions/third-party/WorldScrawl/index.js'); const mv = { direction: 'x', to_name: 'Secret Vault' };
        return [m.moveNote('User', { ...mv, direction: 'trapdoor' }, { direction: 'trapdoor', hidden: true }), m.moveNote('User', { ...mv, direction: 'crawlspace' }, { direction: 'crawlspace', obscured: true }),
            m.moveNote('User', { ...mv, direction: 'north' }, { direction: 'north', to: 'r:v', to_name: 'Secret Vault' })]; });
    const mv2 = await page.evaluate(async () => { const m = await import('/scripts/extensions/third-party/WorldScrawl/index.js');
        const get = async a => (await fetch('http://127.0.0.1:5199/location/' + encodeURIComponent(a))).json();
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
    check('leaving words + way-out text', JSON.stringify(lw) === '[true,false,"Which way out? out (Village Square), gate (Market Lane)"]', JSON.stringify(lw));
    await go('out', 'west', 'gate');
    check('stable reached via the gate', (await stored()) === 'riverton:drowned_rat/stable', String(await stored()));
    await go('gate', 'store', 'The Drowned Rat');
    check('after visiting the stable: building -> stable', (await stored()) === 'riverton:drowned_rat/stable', String(await stored()));
    // Building by name from further away (Goose upstairs: stable 3 steps, common room 4; the store: 2 vs 3).
    const stableDesc = await page.evaluate(async () => (await (await fetch('http://127.0.0.1:5199/location/' + encodeURIComponent('riverton:drowned_rat/stable'))).json()).description);
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
    check('fresh chat + first turn: only /start (no neighbour fetches)', JSON.stringify(apiCalls) === '["/start"]', JSON.stringify(apiCalls));
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
    const travelStub = u => u.href.endsWith('/travel');
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
    const verStub = u => u.href.endsWith('/health');
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
    // Swiping the greeting keeps/restamps the start location.
    await page.evaluate(async () => { const c = SillyTavern.getContext(); delete c.chat[0].extra.worldscrawl_location; for (let i = 1; i < c.chat.length; i++) if (c.chat[i].extra) delete c.chat[i].extra.worldscrawl_location; await c.eventSource.emit(c.eventTypes.MESSAGE_SWIPED, 0); });
    await page.waitForTimeout(1000);
    check('greeting restamped after swipe', await page.evaluate(() => SillyTavern.getContext().chat[0]?.extra?.worldscrawl_location === 'riverton:drowned_rat/common_room'));
    await page.screenshot({ path: '/tmp/ws-e2e.png' });
} finally {
    await browser.close();
}
console.log(failures ? `${failures} FAILED` : 'ALL PASSED');
process.exit(failures ? 1 : 0);
