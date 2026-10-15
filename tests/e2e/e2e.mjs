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
        for (let i = 0; i < 60; i++) { const r = await (await fetch(`${FAKE}/__requests`)).json(); if (r.length >= expected) break; await page.waitForTimeout(500); }
        await page.waitForFunction(() => !jQuery('#mes_stop').is(':visible'), null, { timeout: 30000 });
        await page.waitForTimeout(2000);
    };
    const stored = () => page.evaluate(() => { const ch = SillyTavern.getContext().chat; for (let i = ch.length - 1; i >= 0; i--) if (ch[i]?.extra?.worldscrawl_location) return ch[i].extra.worldscrawl_location; return null; });

    await queue([{ tool_calls: [{ name: 'ws_look' }] }, { content: 'You are in the tavern.' }]);
    await send('Where am I?');
    check('look stamps start location', (await stored()) === 'riverton:tavern', String(await stored()));

    await queue([{ tool_calls: [{ name: 'ws_move', arguments: { direction: 'out' } }] }, { content: 'You step into the square.' }]);
    await send('I go outside.');
    check('move out -> square', (await stored()) === 'riverton:square', String(await stored()));
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
    check('bad move keeps location', (await stored()) === 'riverton:square');
    const reqs2 = await (await fetch(`${FAKE}/__requests`)).json();
    check('bad move returns valid directions', JSON.stringify(reqs2[reqs2.length - 1].messages).includes('valid_directions'));

    await queue([{ tool_calls: [{ name: 'ws_move', arguments: { direction: 'north' } }] }, { content: 'The temple.' }]);
    await send('Up to the temple.');
    check('move north -> temple', (await stored()) === 'riverton:temple');

    // Deleting the last exchange (user msg, tool record, reply) rolls the location back.
    await page.evaluate(async () => { const c = SillyTavern.getContext(); await c.executeSlashCommandsWithOptions('/del 3'); });
    await page.waitForTimeout(1500);
    check('deleting messages rolls location back', (await stored()) === 'riverton:square', String(await stored()));

    // Survives reload (saved with the chat).
    await page.reload(); await page.waitForSelector('#send_textarea', { timeout: 60000 }); await page.waitForTimeout(3000);
    await page.evaluate(async () => { await SillyTavern.getContext().selectCharacterById(0); });
    await page.waitForTimeout(3000);
    check('location persisted with chat', (await stored()) === 'riverton:square', String(await stored()));
    check('footer re-rendered on chat load', ((await footer()) ?? '').startsWith('Exits:'), String(await footer()));
    const reqs3 = await (await fetch(`${FAKE}/__requests`)).json();
    check('footer never sent to model', !reqs3.some(r => JSON.stringify(r.messages).includes('Exits: ')));
    check('facts injected (tool mode)', reqs3.some(r => JSON.stringify(r.messages).includes('World state from the game engine')));

    // Part 2: engine-driven movement (default mode). Location is riverton:square here.
    await page.evaluate(() => { const r = document.querySelector('input[name="worldscrawl_mode"][value="typed"]'); r.checked = true; r.dispatchEvent(new Event('change')); });
    await page.waitForTimeout(500);
    check('tools unregistered when off', !(await toolNames()).includes('ws_move'));
    const lastReq = async () => { const r = await (await fetch(`${FAKE}/__requests`)).json(); return r[r.length - 1]; };
    const waitReqs = async () => { for (let i = 0; i < 60; i++) { const r = await (await fetch(`${FAKE}/__requests`)).json(); if (r.length >= expected) break; await page.waitForTimeout(500); } await page.waitForFunction(() => !jQuery('#mes_stop').is(':visible'), null, { timeout: 30000 }); await page.waitForTimeout(2000); };

    // The reload above dropped the API connection; reconnect.
    await page.evaluate(() => jQuery('#api_button_openai').trigger('click'));
    await page.waitForTimeout(3000);
    await page.evaluate(async () => { const o = await import('/scripts/openai.js'); o.oai_settings.stream_openai = false; });
    // Typed movement: intent question answered "south" -> engine moves to the docks.
    await queue([{ content: ' South.' }, { content: 'You walk down to the docks.' }]);
    await send('Let us head down to the river.', 2);
    let all = await (await fetch(`${FAKE}/__requests`)).json();
    const intentReq = JSON.stringify(all[all.length - 2].messages);
    check('intent question asked with exit list', /Which option: in, south, north, east, [^?]*stay, elsewhere\?/.test(intentReq), intentReq.slice(0, 200));
    check('intent request has no tools', !JSON.stringify(all[all.length - 2].tools ?? []).includes('ws_move'));
    check('intent marks where you came from', intentReq.includes('in (to The Drowned Rat, where you came from)'), intentReq.slice(0, 400));
    check('typed movement moved party', (await stored()) === 'riverton:docks', String(await stored()));
    let narr = JSON.stringify((await lastReq()).messages);
    check('narration got arrival facts', narr.includes('The party moved south from Village Square to River Docks') && narr.includes('never move the party'), '');
    check('narration request has no tools', !JSON.stringify((await lastReq()).tools ?? []).includes('ws_move'));
    check('no nudge when tools off', !narr.includes('call ws_look'));

    // Typed non-movement: "none" -> no move, no arrival line.
    await queue([{ content: 'stay' }, { content: 'You look at the boats.' }]);
    await send('I look at the boats.', 2);
    check('non-movement keeps location', (await stored()) === 'riverton:docks');
    narr = JSON.stringify((await lastReq()).messages);
    check('no arrival line without a move', !narr.includes('What just happened') && narr.includes('Current location: River Docks') && narr.includes('The party has NOT moved this turn and is still at River Docks'));

    // Invalid answer (not on the list) is treated as none.
    await queue([{ content: 'I think they go to the temple' }, { content: 'no' }, { content: 'Hmm.' }]);
    await send('Maybe the temple?', 3);
    check('non-list answer = no move', (await stored()) === 'riverton:docks');

    // Clicking an exit in the footer of the latest reply.
    check('only latest footer has buttons', await page.evaluate(() => { const f = [...document.querySelectorAll('#chat .worldscrawl_exits')]; return f.length > 1 && f.slice(0, -1).every(x => !x.querySelector('.worldscrawl_exit')) && !!f[f.length - 1].querySelector('.worldscrawl_exit'); }));
    await queue([{ content: 'Back in the square.' }]);
    expected += 1;
    await page.click('#chat .mes:last-child .worldscrawl_exit[data-direction="north"]');
    await waitReqs();
    check('click moves party', (await stored()) === 'riverton:square', String(await stored()));
    check('click adds party note', await page.evaluate(() => SillyTavern.getContext().chat.some(m => m.is_user && m.mes === '*The party goes north.*')));
    narr = JSON.stringify((await lastReq()).messages);
    check('click narration has arrival facts', narr.includes('The party moved north from River Docks to Village Square'));
    check('click did not ask intent', (await (await fetch(`${FAKE}/__requests`)).json()).length === expected);

    // /ws-go and /ws-exits.
    await queue([{ content: 'The temple.' }]);
    expected += 1;
    await page.evaluate(() => SillyTavern.getContext().executeSlashCommandsWithOptions('/ws-go North'));
    await waitReqs();
    check('/ws-go moves party', (await stored()) === 'riverton:temple', String(await stored()));
    const ex = await page.evaluate(async () => (await SillyTavern.getContext().executeSlashCommandsWithOptions('/ws-exits')).pipe);
    check('/ws-exits lists exits', ex === 'Exits: south (Village Square)', String(ex));
    const before = (await (await fetch(`${FAKE}/__requests`)).json()).length;
    await page.evaluate(() => SillyTavern.getContext().executeSlashCommandsWithOptions('/ws-go sideways'));
    await page.waitForTimeout(1500);
    check('/ws-go bad direction: no move, no generation', (await stored()) === 'riverton:temple' && (await (await fetch(`${FAKE}/__requests`)).json()).length === before);
    check('engine footer never in message text', await page.evaluate(() => !SillyTavern.getContext().chat.some(m => /Exits:/.test(m.mes ?? ''))));

    // Intent setting off: no question asked.
    await page.evaluate(() => { const r = document.querySelector('input[name="worldscrawl_mode"][value="commands"]'); r.checked = true; r.dispatchEvent(new Event('change')); });
    await queue([{ content: 'You stay.' }]);
    await send('I go south.', 1);
    check('clicks-and-commands mode: no move, single request', (await stored()) === 'riverton:temple' && !JSON.stringify((await lastReq()).messages).includes('Which option'));

    // Temple from the tavern (not adjacent): blocked with a game message, no narration call.
    await page.evaluate(() => { const r = document.querySelector('input[name="worldscrawl_mode"][value="typed"]'); r.checked = true; r.dispatchEvent(new Event('change')); });
    await queue([{ content: 'Square.' }, { content: 'Tavern.' }]); expected += 2;
    await page.evaluate(() => SillyTavern.getContext().executeSlashCommandsWithOptions('/ws-go south')); await waitReqs();
    await page.evaluate(() => SillyTavern.getContext().executeSlashCommandsWithOptions('/ws-go in')); await waitReqs();
    check('back in the tavern', (await stored()) === 'riverton:tavern', String(await stored()));
    const lastMsg = () => page.evaluate(() => { const ch = SillyTavern.getContext().chat; const m = ch[ch.length - 1], u = ch[ch.length - 2]; return { mes: m.mes, sys: !!m.is_system, prev: u.mes, prevUser: !!u.is_user }; });
    await queue([{ content: 'elsewhere' }]);
    await send('go to the temple', 1);
    let lm = await lastMsg();
    check('unreachable: location unchanged', (await stored()) === 'riverton:tavern');
    check('unreachable: game message shown', lm.sys && lm.mes === "You can't get there from here. Exits: out (Village Square), up (Upstairs Rooms)", JSON.stringify(lm));
    check('unreachable: user message kept', lm.prevUser && lm.prev === 'go to the temple');
    check('unreachable: no narration call', (await (await fetch(`${FAKE}/__requests`)).json()).length === expected && JSON.stringify((await lastReq()).messages).includes('Which option'));
    const noticeBtns = () => page.evaluate(() => { const els = [...document.querySelectorAll('#chat .mes')]; return els.filter(e => /can't get there from here/.test(e.textContent)).map(e => [...e.querySelectorAll('.worldscrawl_exit')].map(b => b.textContent)); });
    check('game message exits are buttons', JSON.stringify((await noticeBtns()).pop()) === '["out (Village Square)","up (Upstairs Rooms)"]', JSON.stringify(await noticeBtns()));
    check('game message visible in chat', await page.evaluate(() => [...document.querySelectorAll('#chat .mes')].some(e => /can't get there from here/.test(e.textContent))));

    // Unparseable answer on a travel-looking message fails closed.
    await queue([{ content: '<think>hmm, the castle?</think>I am not sure' }, { content: 'Yes' }]);
    await send('I walk to the castle', 2);
    lm = await lastMsg();
    check('garbled answer + yes follow-up: blocked', lm.sys && /can't get there/.test(lm.mes) && (await stored()) === 'riverton:tavern', JSON.stringify(lm));
    check('follow-up question asked', JSON.stringify((await lastReq()).messages).includes('Is the player trying to travel to a different place? Answer yes or no.'));

    let nb = await noticeBtns();
    check('only latest game message clickable', nb.length >= 2 && nb.slice(0, -1).every(x => x.length === 0) && nb[nb.length - 1].length === 2, JSON.stringify(nb));
    // Survives a reload (rebuilt from stored data).
    await page.reload(); await page.waitForSelector('#send_textarea', { timeout: 60000 }); await page.waitForTimeout(3000);
    await page.evaluate(async () => { await SillyTavern.getContext().selectCharacterById(0); });
    await page.waitForTimeout(3000);
    nb = await noticeBtns();
    check('game message buttons survive reload', nb.length >= 2 && nb[nb.length - 1].length === 2, JSON.stringify(nb));
    await page.evaluate(() => jQuery('#api_button_openai').trigger('click'));
    await page.waitForTimeout(3000);
    await page.evaluate(async () => { const o = await import('/scripts/openai.js'); o.oai_settings.stream_openai = false; });
    // Clicking an exit in the game message moves the party.
    await queue([{ content: 'Upstairs.' }]); expected += 1;
    await page.click('#chat .mes:last-child .worldscrawl_exit[data-direction="up"]');
    await waitReqs();
    check('game message button moves party', (await stored()) === 'riverton:tavern_rooms', String(await stored()));
    await queue([{ content: 'Down again.' }]); expected += 1;
    await page.evaluate(() => SillyTavern.getContext().executeSlashCommandsWithOptions('/ws-go down')); await waitReqs();

    // Garbled answer on a non-travel message ("run my hand" would have tripped the old keyword list): normal reply.
    await queue([{ content: 'blorp' }, { content: 'no' }, { content: 'The wood is smooth.' }]);
    await send('I run my hand along the bar', 3);
    lm = await lastMsg();
    narr = JSON.stringify((await lastReq()).messages);
    check('bar: normal reply, no game message', !lm.sys && lm.mes === 'The wood is smooth.' && (await stored()) === 'riverton:tavern', JSON.stringify(lm));
    check('bar: not-moved injection', narr.includes('The party has NOT moved this turn and is still at The Drowned Rat'));

    // Think tags stripped before matching; a real move still works, and the game messages never reach the model.
    await queue([{ content: '<think>they want to go outside</think>\nOut' }, { content: 'The square.' }]);
    await send('step outside', 2);
    check('think-tag answer moves party', (await stored()) === 'riverton:square', String(await stored()));
    const allReqs = await (await fetch(`${FAKE}/__requests`)).json();
    check('game messages never sent to model', !allReqs.some(r => JSON.stringify(r.messages).includes("can't get there from here")));

    // Route-finding to a visited place: tavern -> square -> temple.
    await queue([{ content: 'Tavern.' }]); expected += 1;
    await page.evaluate(() => SillyTavern.getContext().executeSlashCommandsWithOptions('/ws-go in')); await waitReqs();
    await queue([{ content: 'Temple of the Tides' }, { content: 'A walk up the hill.' }]);
    await send('go to the temple', 2);
    const routeQ = JSON.stringify(all = (await (await fetch(`${FAKE}/__requests`)).json()), null, 0);
    check('visited place offered as option', /Which option: out, up, [^?]*Temple of the Tides[^?]*, stay, elsewhere\?/.test(JSON.stringify(all[all.length - 2].messages)), JSON.stringify(all[all.length - 2].messages).slice(-200));
    check('route: arrived at temple', (await stored()) === 'riverton:temple', String(await stored()));
    check('route: journey facts', JSON.stringify((await lastReq()).messages).includes('The party travelled from The Drowned Rat through Village Square to Temple of the Tides'));
    check('route: saved the path', await page.evaluate(() => { const ch = SillyTavern.getContext().chat; const u = ch.filter(m => m.is_user).pop(); return JSON.stringify(u.extra.worldscrawl_move.via) === '["riverton:square","riverton:temple"]'; }));
    await queue([{ content: 'Back at the tavern.' }]); expected += 1;
    await page.evaluate(() => SillyTavern.getContext().executeSlashCommandsWithOptions('/ws-go The Drowned Rat')); await waitReqs();
    check('/ws-go visited place name', (await stored()) === 'riverton:tavern', String(await stored()));

    check('seen-but-not-visited place offered (docks)', /Which option: [^?]*River Docks/.test(JSON.stringify(all[all.length - 2].messages)));
    // New chat: the temple is not discovered yet, so it isn't offered and the trip is refused.
    await page.evaluate(() => SillyTavern.getContext().executeSlashCommandsWithOptions('/newchat'));
    await page.waitForTimeout(3000);
    await queue([{ content: 'elsewhere' }]);
    await send('go to the temple', 1);
    lm = await lastMsg();
    const q = JSON.stringify((await lastReq()).messages);
    check('new chat: temple not offered', q.includes('Which option: out, up, stay, elsewhere?') && !q.includes('Temple of the Tides'), q.slice(-160));
    check('new chat: temple refused', lm.sys && /can't get there/.test(lm.mes) && (await stored()) === null, JSON.stringify(lm));
    await page.screenshot({ path: '/tmp/ws-e2e.png' });
} finally {
    await browser.close();
}
console.log(failures ? `${failures} FAILED` : 'ALL PASSED');
process.exit(failures ? 1 : 0);
