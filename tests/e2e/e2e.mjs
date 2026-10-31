import { chromium } from 'playwright-core';
const E2E_TMP = process.env.E2E_TMP || '/tmp';
const BASE = `http://localhost:${process.env.E2E_PORT || 8767}/`;
const FAKE = `http://127.0.0.1:${process.env.E2E_FAKE_PORT || 9098}`;
let failures = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}: ${name} ${extra}`); if (!ok) failures++; };
const pickSet = (loc, v) => loc.evaluate((el, x) => el.setValue(x), v); // a map pick field's value, as a pick sets it
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
        const out = [];
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
    check('answer parsing (think tags, prefixes, exact match)', JSON.stringify(mig) === '["out","elsewhere","stay",null,null,"yes",null,"[{\\"direction\\":\\"to_b\\",\\"to\\":\\"r:b\\"},{\\"direction\\":\\"to_c\\",\\"to\\":\\"r:c\\"}]","Exits: north, out (Village Square)","north",true]', JSON.stringify(mig));
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
    await page.evaluate(async fake => {
        const $ = window.jQuery;
        $('#main_api').val('openai').trigger('change');
        $('#chat_completion_source').val('custom').trigger('change');
        $('#custom_api_url_text').val(fake + '/v1').trigger('input');
        $('#custom_model_id').val('fake-model').trigger('input');
        $('#stream_toggle').prop('checked', false).trigger('input');
        $('#openai_function_calling').prop('checked', true).trigger('input');
    }, FAKE);
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
    check('no carded NPC in the square: no Named NPCs line', await page.evaluate(() => [...document.querySelectorAll('#chat .mes')].at(-1)?.querySelector('.worldscrawl_npcs_here') == null) && !/Named NPCs present/.test(f1 ?? ''), String(f1));
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

    // Narrator wait: dedicated ws_wait tool, the [ws_wait: ...] tag, and the ws_flag alias - each waits on a Keep / Adjust / Discard card.
    const waits = () => page.evaluate(() => SillyTavern.getContext().chat.map(m => m?.extra?.worldscrawl_wait).filter(Boolean));
    const waitCards = () => page.evaluate(() => SillyTavern.getContext().chat.map(m => m?.extra?.worldscrawl_waitcard).filter(Boolean));
    const cardClick = (label, amount) => page.evaluate(async ({ label, amount }) => {
        const card = [...document.querySelectorAll('.worldscrawl_waitcard')].pop(); if (!card) return false;
        if (amount != null) card.querySelector('.worldscrawl_wait_amount').value = amount;
        const b = [...card.querySelectorAll('.menu_button, button, div')].find(x => x.textContent.trim() === label); if (!b) return false;
        b.click(); await new Promise(r => setTimeout(r, 800)); return true; }, { label, amount });
    check('ws_npc tool lists disposition with its values and a reason', (() => { const t = (reqs[0].tools ?? []).find(x => (x.function?.name ?? x.name) === 'ws_npc'); const ps = (t?.function ?? t)?.parameters?.properties ?? {}; return /disposition/.test(ps.action?.description ?? '') && JSON.stringify(ps.value?.enum) === JSON.stringify(['hostile', 'unfriendly', 'indifferent', 'friendly', 'helpful']) && !!ps.reason; })(), JSON.stringify((reqs[0].tools ?? []).map(x => x.function?.name ?? x.name)));
    check('ws_wait tool sent to model', JSON.stringify(reqs[0].tools ?? []).includes('ws_wait'));
    check('Auto-keep waits is off by default', await page.evaluate(() => SillyTavern.getContext().extensionSettings.worldscrawl.autoKeepWaits === false && !document.getElementById('worldscrawl_auto_keep_waits').checked));
    check('ws_wait tool description comes from the prompt file (clearly 15 minutes or more, if unclear don\'t, reason)', JSON.stringify(reqs[0].tools ?? []).includes('clearly take 15 minutes or more') && JSON.stringify(reqs[0].tools ?? []).includes("isn't clear, don't") && JSON.stringify(reqs[0].tools ?? []).includes('"reason"'));
    await queue([{ tool_calls: [{ name: 'ws_wait', arguments: { duration: '3h', reason: 'waiting for the ferry' } }] }, { content: 'You wait by the well.' }]);
    await send('I wait three hours.');
    let ws = await waits();
    check('ws_wait tool: a card, nothing stamped yet', ws.length === 0 && (await waitCards()).length === 1 && await page.evaluate(() => /swipe/.test(document.querySelector('.worldscrawl_waitcard')?.textContent ?? '')), JSON.stringify(await waitCards()));
    check('ws_wait reason: on the card and in the inspector call log', (await waitCards())[0]?.reason === 'waiting for the ferry' && await page.evaluate(() => /Why: waiting for the ferry/.test(document.querySelector('.worldscrawl_waitcard .worldscrawl_wait_reason')?.textContent ?? '')), JSON.stringify(await waitCards()));
    check('ws_wait keeps location', (await stored()) === 'riverton:streets/square');
    check('ws_wait tool result tells model the time', JSON.stringify((await (await fetch(`${FAKE}/__requests`)).json()).at(-1).messages).includes('Time passes'));
    check('Approve on the card stamps 3h', await cardClick('Approve') && (ws = await waits()).length === 1 && ws[0].seconds === 3 * 3600 && !ws[0].sleep && (await waitCards()).length === 0, JSON.stringify(ws));
    await queue([{ content: 'You bed down on a bench. [ws_wait: sleep until morning | sleeping on the bench]' }]);
    await send('I sleep.', 1);
    check('[ws_wait] tag: a card with the amount', JSON.stringify(await waitCards()).includes('until morning') && (await waits()).length === 1, JSON.stringify(await waitCards()));
    check('[ws_wait] tag reason shows on the card', /Why: sleeping on the bench/.test(await page.evaluate(() => document.querySelector('.worldscrawl_waitcard')?.textContent ?? '')));
    check('[ws_wait] tag stripped from reply', await page.evaluate(() => { const b = SillyTavern.getContext().chat.filter(m => /bench/.test(m.mes ?? '')); return b.length > 0 && b.every(m => !/ws_wait/.test(m.mes)); }));
    check('Adjust stamps the edited amount (6h sleep) with its reason', await cardClick('Adjust', '6h') && (ws = await waits()).length === 2 && ws[1].sleep && ws[1].seconds === 6 * 3600 && ws[1].reason === 'sleeping on the bench', JSON.stringify(ws));
    await queue([{ tool_calls: [{ name: 'ws_flag', arguments: { action: 'wait', note: '1h' } }] }, { content: 'An hour passes.' }]);
    await send('I wait an hour.');
    check('ws_flag wait alias: a card', (await waitCards()).length === 1 && (await waits()).length === 2);
    check('Discard: no time passes', await cardClick('Discard') && (await waitCards()).length === 0 && (await waits()).length === 2, JSON.stringify(await waits()));
    await queue([{ tool_calls: [{ name: 'ws_flag', arguments: { action: 'wait', note: '1h' } }] }, { content: 'An hour passes.' }]);
    await send('I wait an hour.');
    await cardClick('Approve');
    ws = await waits();
    check('ws_flag wait alias kept stamps 1h', ws.length === 3 && ws[2].seconds === 3600, JSON.stringify(ws));
    await page.evaluate(async () => { await SillyTavern.getContext().executeSlashCommandsWithOptions('/del 11'); });
    await page.waitForTimeout(1500);
    check('deleting wait messages undoes them', (await waits()).length === 0, JSON.stringify(await waits()));
    await queue([{ content: 'You pause briefly. [ws_wait: 10m]' }]);
    await send('I catch my breath.', 1);
    check('narrator wait under 15 minutes: no card, no clock change', (await waitCards()).length === 0 && (await waits()).length === 0, JSON.stringify(await waitCards()));
    await page.evaluate(async () => { await SillyTavern.getContext().executeSlashCommandsWithOptions('/del 2'); }); await page.waitForTimeout(1000);
    await queue([{ content: 'Two hours drag by. [ws_wait: 1h]' }]);
    await page.evaluate(async () => { await SillyTavern.getContext().executeSlashCommandsWithOptions('/ws-wait 2h'); }); expected += 1; for (let i = 0; i < 60 && (await (await fetch(`${FAKE}/__requests`)).json()).length < expected; i++) await page.waitForTimeout(500); await page.waitForTimeout(2000);
    ws = await waits();
    check('explicit /ws-wait applies directly; the narrator\'s wait on that turn gets no card', ws.length === 1 && ws[0].seconds === 7200 && (await waitCards()).length === 0, JSON.stringify([ws, await waitCards()]));
    await page.evaluate(async () => { await SillyTavern.getContext().executeSlashCommandsWithOptions('/del 2'); }); await page.waitForTimeout(1500);
    check('explicit wait removed again', (await waits()).length === 0, JSON.stringify(await waits()));

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
    // Regression: the preset's "Replace empty message" must not become an extra player message after a move.
    await page.evaluate(async () => { const o = await import('/scripts/openai.js'); o.oai_settings.send_if_empty = '(POV Character stays silent or continues doing previous action)'; });
    const goN0 = await page.evaluate(() => SillyTavern.getContext().chat.length);
    await page.evaluate(() => SillyTavern.getContext().executeSlashCommandsWithOptions('/ws-go North'));
    await waitReqs();
    const goNew = await page.evaluate(n => SillyTavern.getContext().chat.slice(n).filter(m => !m.is_system).map(m => ({ u: !!m.is_user, mes: m.mes })), goN0);
    check('move: exactly one player line then one narrator reply (no empty-send filler)', goNew.length === 2 && goNew[0].u && !goNew[1].u && !goNew.some(m => m.mes.includes('stays silent')), JSON.stringify(goNew));
    await page.evaluate(async () => { const o = await import('/scripts/openai.js'); o.oai_settings.send_if_empty = ''; });
    check('/ws-go moves party', (await stored()) === 'riverton:temple/nave', String(await stored()));
    narr = JSON.stringify((await lastReq()).messages);
    check('lore: temple index lists only the temple (inherit_lore false), lore itself not fed', narr.includes('Lore on file: Temple of the Tides.') && !narr.includes('A hushed, holy place') && !narr.includes('About Riverton:'), narr.slice(0, 300));
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
    check('lore: quiet upstairs indexes region lore only (location override), nothing fed', narr.includes('Lore on file: Riverton.') && !narr.includes("Riverton's oldest tavern") && !narr.includes('Background knowledge (lore)'));
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
    check('lore: tavern index names the tavern and the region; description fed, lore not', narr.includes('Lore on file: The Drowned Rat, Riverton.') && !narr.includes("Riverton's oldest tavern") && narr.includes('This location: A low-beamed'));
    expected += 1; await page.evaluate(() => SillyTavern.getContext().executeSlashCommandsWithOptions('/ws-wait until 5pm')); await waitReqs(); // Hesk pours drinks from 16:00
    await queue([{ content: 'Hesk eyes you.' }]);
    await send('[lore] The Drowned Rat', 1);
    narr = JSON.stringify((await lastReq()).messages);
    const npcLine = await page.evaluate(async mod => { const m = await import(mod), c = SillyTavern.getContext(), id = c.chat.length - 1; return { line: [...document.querySelectorAll('#chat .mes')].at(-1)?.querySelector('.worldscrawl_npcs_here')?.textContent ?? null, names: m.namedNpcsAt(c.chat, id, c.chat[id].extra?.worldscrawl_location) }; }, '/scripts/extensions/third-party/WorldScrawl/index.js');
    check('footer: Named NPCs present lists the carded NPCs here (Hesk in the tavern), display only', npcLine.names.length > 0 && npcLine.line === 'Named NPCs present: ' + npcLine.names.join(', ') && !narr.includes('Named NPCs present'), JSON.stringify(npcLine));
    check('lore: [lore] feeds the tavern lore as background knowledge, {{npc:hesk}} as a name', narr.includes('Background knowledge (lore)') && narr.includes("Riverton's oldest tavern") && narr.includes('Hesk') && !narr.includes('{{npc:') && !narr.includes('Riverton is a small'), narr.slice(0, 400));
    const lr = await page.evaluate(() => SillyTavern.getContext().chat.flatMap(m => m.extra?.worldscrawl_lore ?? []));
    check('lore: the [lore] request is stamped {swipe, place, level, address, source}', lr.length === 1 && lr[0].source === 'bracket' && lr[0].place === 'The Drowned Rat' && lr[0].level === 'subregion' && lr[0].address === 'riverton:drowned_rat/common_room', JSON.stringify(lr));
    await queue([{ content: 'stay' }, { content: 'She pours an ale. [ws_flag: lore | Riverton]' }]);
    await send('I order an ale.');
    narr = JSON.stringify((await lastReq()).messages);
    check('lore: still fed later in the scene', narr.includes("Riverton's oldest tavern"));
    const loreMes = await page.evaluate(() => SillyTavern.getContext().chat.at(-1).mes);
    check('lore: the narrator flag tag is stripped from the reply', loreMes === 'She pours an ale.', loreMes);
    await queue([{ content: 'stay' }, { content: 'You sip.' }]);
    await send('I sip it.');
    narr = JSON.stringify((await lastReq()).messages);
    const lr2 = await page.evaluate(() => SillyTavern.getContext().chat.flatMap(m => m.extra?.worldscrawl_lore ?? []));
    check('lore: the narrator flag feeds region lore the next turn', lr2.some(r => r.source === 'flag' && r.level === 'region') && narr.includes('Background knowledge (lore)') && /- Riverton: /.test(narr), JSON.stringify(lr2));
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
    await page.evaluate(async () => { const c = SillyTavern.getContext(); c.chat.push({ name: 'User', is_user: true, mes: 'v', extra: { worldscrawl_location: 'atlantis:nowhere/void', worldscrawl_intent_checked: true } }); await c.saveChat(); });
    const exMissing = await wsExits();
    check('missing room: walks back to the last room in the move history, with a system notice', (await lastMes()).includes('no longer exists in this world') && (await stored()) === 'riverton:streets/square' && exMissing.startsWith('Exits: in'), exMissing + ' | ' + (await lastMes()));
    await page.evaluate(() => document.getElementById('worldscrawl_who').dispatchEvent(new Event('input'))); // refresh the facts prompt
    await page.waitForTimeout(800);
    check('missing room: the narrator gets one "now in" note', /no longer exists in this world\. .* is now in /.test(await page.evaluate(() => SillyTavern.getContext().extensionPrompts?.worldscrawl_facts?.value ?? '')));
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
    (await import('node:fs')).rmSync(`${E2E_TMP}/ws-worlds/${doomed.id}`, { recursive: true, force: true });
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
    // Window -> Village Square in ONE JSON call; the first answer reuses "down" (taken) and the call is retried once with the error.
    // The second answer names the place loosely ("Village Square") and says "go through": lenient key matching.
    await queue([{ content: 'new opening' }, { content: '{"existing":"village_square","direction":"down","then":"go_through"}' }, { content: 'Sure: {"existing":"Village Square","direction":"Window","then":"go through"}' }, { content: 'You land in the square in a shower of glass.' }]);
    await send('I run down the hall and leap through the window, breaking through the glass', 4);
    lu = await lastU();
    const rq = (await reqsNow()).slice(r0);
    const ch1 = lu.extra.worldscrawl_change;
    check('dig narrative: intent prompt offers the new opening choice', promptOf(rq[0]).includes('new opening: the player clearly breaks through'), promptOf(rq[0]).slice(0, 300));
    check('dig narrative: one JSON question listing nearby places as keys + a new place (no numbers)', promptOf(rq[1]).includes('- village_square: Village Square') && promptOf(rq[1]).includes('Or it can lead to a new space nobody has seen yet') && promptOf(rq[1]).includes('Reply with JSON only') && !promptOf(rq[1]).includes('just the number'), promptOf(rq[1]).slice(0, 900));
    check('dig narrative: a bad answer is retried once with the error, then narration', rq.length === 4 && promptOf(rq[2]).includes('Your last answer did not fit: there is already an exit') && promptOf(rq[2]).includes('down'), String(rq.length) + promptOf(rq[2]).slice(-300));
    check('dig narrative: connect to an existing place = the linked exit pair stamped on the player message, return name "back"', ch1?.type === 'dig' && ch1.from === 'riverton:drowned_rat/upstairs' && ch1.to === 'riverton:streets/square' && ch1.direction === 'window' && ch1.return_direction === 'back' && lu.extra.worldscrawl_dig?.direction === 'window', JSON.stringify(lu.extra));
    check('dig narrative: party moved through the window to Village Square (move stamped on the same message)', (await stored()) === 'riverton:streets/square' && lu.extra.worldscrawl_location === 'riverton:streets/square' && lu.extra.worldscrawl_move?.direction === 'window' && (await wsExits()).includes('back (The Drowned Rat, Upstairs Rooms)'), await wsExits());
    check('dig narrative: narration told about breaking through and arriving', promptOf(rq[3]).includes('broke through, making a new opening (window) from Upstairs Rooms') && promptOf(rq[3]).includes('Narrate breaking through and arriving in Village Square'), promptOf(rq[3]).slice(-800));
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
    // "...and peer through": then "stay" -> dig only, the party stays.
    await queue([{ content: 'new opening' }, { content: '{"existing":"village_square","direction":"hole","return_direction":"hole","then":"stay"}' }, { content: 'You peer through.' }]);
    await send('I smash a hole in the wall and peer through', 3);
    lu = await lastU();
    check('dig narrative: "peer through" ("stay") -> dig, no move', lu.extra.worldscrawl_change?.direction === 'hole' && lu.extra.worldscrawl_change?.return_direction === 'hole' && !lu.extra.worldscrawl_move && (await stored()) === 'riverton:drowned_rat/upstairs' && (await wsExits()).includes('hole (Village Square') && promptOf(await lastReq()).includes('broke through, making a new opening (hole) from here'), await wsExits());
    await page.evaluate(async i => { const c = SillyTavern.getContext(); await c.executeSlashCommandsWithOptions(`/cut ${i}-${c.chat.length - 1}`); }, lu.i); await page.waitForTimeout(1500);
    // Somewhere new: the same create_place edit discovery uses, in this building, walkable both ways; an unclear "then" goes through.
    await queue([{ content: 'new opening' }, { content: '```json\n{"new":{"name":"dusty crawl space","description":"A cramped crawlspace full of cobwebs"},"direction":"the hole","then":"maybe"}\n```' }, { content: 'You climb down.' }]);
    await send('I bash a hole through the floorboards', 3);
    lu = await lastU();
    const ch2 = lu.extra.worldscrawl_change, to2 = lu.extra.worldscrawl_dig?.to;
    check('dig narrative: a new place is one create_place patch (engine-made id) in the current subregion', ch2?.type === 'patch' && ch2.ops?.length === 1 && ch2.ops[0].op === 'create_place' && ch2.ops[0].name === 'Dusty Crawl Space' && ch2.ops[0].description === 'A cramped crawlspace full of cobwebs.' && ch2.ops[0].exits?.[0]?.return_direction === 'hole' && ch2.ops[0].exits[0].direction === 'back' && String(to2).startsWith('riverton:drowned_rat/'), JSON.stringify(lu.extra));
    check('dig narrative: unclear "then" -> goes through, party ends in the new room; narration gets its description', (await stored()) === to2 && promptOf(await lastReq()).includes('This location: A cramped crawlspace full of cobwebs.'), String(await stored()));
    check('dig narrative: in the new room; its way back listed', (await stored()) === to2 && (await wsExits()) === 'Exits: back (Upstairs Rooms)', await wsExits());
    await go('back');
    // Failure: unreadable answer twice -> no change, a notice, narration says nothing gave way.
    await queue([{ content: 'new opening' }, { content: 'banana' }, { content: '{"existing":"the moon","direction":"up"}' }, { content: 'You strain.' }]);
    const rF = (await reqsNow()).length;
    await send('I smash the wall with my fist until it breaks', 4);
    lu = await lastU();
    const fq = (await reqsNow()).slice(rF);
    check('dig narrative: failed validation -> no change, narrated as failed', !lu.extra.worldscrawl_change && lu.extra.worldscrawl_dig_failed === true && promptOf(await lastReq()).includes('nothing gave way') && promptOf(fq[2]).includes('the answer was not a JSON object'), JSON.stringify(lu.extra));
    // Knarfy's playtest: the player names the courtyard. A "new" answer is refused (named existing place), a second unreadable one
    // still links the named courtyard directly (on a free return name), never a new area.
    await queue([{ content: 'new opening' }, { content: '{"new":{"name":"Precarious Ledge","description":"A narrow ledge above the yard."},"direction":"window","then":"go_through"}' }, { content: 'banana' }, { content: 'You drop into the courtyard.' }]);
    const rK = (await reqsNow()).length;
    await send('I break open the window, opening a precarious passage to the courtyard.', 4);
    lu = await lastU();
    const kq = (await reqsNow()).slice(rK), chK = lu.extra.worldscrawl_change;
    check('dig courtyard: the named place is offered first and no new place is offered', /The player names Courtyard/.test(promptOf(kq[1])) && !promptOf(kq[1]).includes('Or it can lead to a new space'), promptOf(kq[1]).slice(0, 900));
    check('dig courtyard: linked to the existing courtyard, not a new area', chK?.type === 'dig' && chK.to === 'riverton:drowned_rat/courtyard' && chK.direction === 'window' && !['in', 'kitchen', 'stable', 'trapdoor'].includes(chK.return_direction) && !lu.extra.worldscrawl_dig_failed && (await stored()) === 'riverton:drowned_rat/courtyard', JSON.stringify(lu.extra));
    await page.evaluate(async i => { const c = SillyTavern.getContext(); await c.executeSlashCommandsWithOptions(`/cut ${i}-${c.chat.length - 1}`); }, lu.i); await page.waitForTimeout(1500);
    check('dig courtyard: undone', (await stored()) === 'riverton:drowned_rat/upstairs', String(await stored()));
    // A failure the narrator ignores: its [ws_flag: discover] is dropped, so no room appears.
    const chBefore = await M(m => m.chatChanges().length);
    await queue([{ content: 'new opening' }, { content: 'banana' }, { content: 'banana' }, { content: 'The wall bursts open onto a hidden attic. [ws_flag: discover | hole]' }]);
    await send('I smash the wall with my fist until it breaks', 4);
    await page.waitForTimeout(1500);
    const flD = await page.evaluate(() => { const ch = SillyTavern.getContext().chat; return ch[ch.length - 1].extra?.worldscrawl_flag ?? null; });
    lu = await lastU();
    const lpD = promptOf(await lastReq());
    check('dig failed: the narrator is told it failed and its discover flag is ignored', lpD.includes('it FAILED') && lu.extra.worldscrawl_dig_failed === true && flD === null && (await M(m => m.chatChanges().length)) === chBefore, JSON.stringify({ flD, extra: lu.extra, prompt: lpD.slice(-700) }));
    await page.evaluate(async i => { const c = SillyTavern.getContext(); await c.executeSlashCommandsWithOptions(`/cut ${i}-${c.chat.length - 1}`); }, lu.i); await page.waitForTimeout(1500);
    // ---- Looking: the upstairs window (no exit) -> a nearby place, stamped as a view link, same answer next time.
    await sw(true, true);
    await go('up');
    const nearUp = (await (await stFetch('/nearby', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ from: 'riverton:drowned_rat/upstairs' }) })).json()).rooms;
    const sqU = nearUp.findIndex(r => r.address === 'riverton:streets/square') + 1;
    let rL = (await reqsNow()).length;
    await queue([{ content: 'look' }, { content: 'Window.' }, { content: 'village square' }, { content: 'Below, the square bustles.' }]);
    await send('I look out the window', 4);
    let lq = (await reqsNow()).slice(rL), lk = await lastU();
    check('look: intent offers look; target list has the exits plus a window', promptOf(lq[0]).includes('- look: the player looks, peers, peeks or listens') && promptOf(lq[1]).includes('- around: around here in general, nothing specific') && promptOf(lq[1]).includes('- down: the down exit (to Common Room)') && promptOf(lq[1]).includes('- window: out a window or opening with no exit') && promptOf(lq[1]).includes('Reply with just the key.'), promptOf(lq[1]).slice(-400));
    check('look: window view picked from the nearby list and stamped as a view link', promptOf(lq[2]).includes('Which place can they most likely see? Reply with just the key.') && JSON.stringify(lk.extra.worldscrawl_change) === JSON.stringify([{ type: 'view_link', from: 'riverton:drowned_rat/upstairs', to: 'riverton:streets/square' }]), JSON.stringify(lk.extra));
    check('look: narration sees the square, party stays', promptOf(lq[3]).includes('looks out and sees Village Square') && promptOf(lq[3]).includes('Visible from here (no way through): Village Square') && (await stored()) === 'riverton:drowned_rat/upstairs', promptOf(lq[3]).slice(-900));
    rL = (await reqsNow()).length;
    await queue([{ content: 'look' }, { content: 'window' }, { content: 'The square again.' }]);
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
    fsD.cpSync(E2E_TMP + '/ws-worlds/riverton', E2E_TMP + '/ws-worlds/doorsworld', { recursive: true });
    const rp = E2E_TMP + '/ws-worlds/doorsworld/regions/riverton.json', rj = JSON.parse(fsD.readFileSync(rp, 'utf8'));
    const exD = (sub, loc, d) => rj.subregions[sub].locations[loc].exits.find(e => e.direction === d);
    rj.stays_open = true; rj.subregions.drowned_rat.stays_open = false;
    Object.assign(exD('drowned_rat', 'common_room', 'out'), { barrier: {} }); Object.assign(exD('streets', 'square', 'in'), { barrier: {} });
    Object.assign(exD('temple', 'nave', 'south'), { barrier: {} }); Object.assign(exD('streets', 'square', 'east'), { barrier: {}, stays_open: false });
    fsD.writeFileSync(rp, JSON.stringify(rj, null, 2));
    fsD.writeFileSync(E2E_TMP + '/ws-worlds/doorsworld/world.json', JSON.stringify({ name: 'Doors World', start_region: 'riverton', living: false, weather_regions: { riverside: { climate: 'temperate' } } }));
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
    // Bracket commands: a known verb skips the intent question; [help] and unresolved targets never reach the narrator.
    const lastChatMsg = () => page.evaluate(() => { const m = SillyTavern.getContext().chat.at(-1); return { mes: m.mes, sys: !!m.is_system, kind: m.extra?.worldscrawl_notice_kind }; });
    rL = (await reqsNow()).length;
    await send('[help]', 0);
    let bm = await lastChatMsg();
    check('bracket [help]: verb list answered directly, no model call', (await reqsNow()).length === rL && bm.kind === 'text' && /\[move\]/.test(bm.mes) && /\/ws-help/.test(bm.mes), JSON.stringify(bm));
    await queue([{ content: 'You take in the room again.' }]);
    await send('I [look] around.', 1);
    lq = (await reqsNow()).slice(rL); lk = await lastU();
    check('bracket [look] around: no intent question, look-around narration, brackets gone for the narrator', lq.length === 1 && lk.extra.worldscrawl_look?.kind === 'around' && promptOf(lq[0]).includes('looks around') && promptOf(lq[0]).includes('I look around.') && !promptOf(lq[0]).includes('[look]'), lq.length + JSON.stringify(lk.extra));
    rL = (await reqsNow()).length;
    await queue([{ content: 'none' }]);
    await send('I [move] sideways', 1);
    lq = (await reqsNow()).slice(rL); bm = await lastChatMsg();
    check('bracket [move] unknown target: one target-only question, then a clear note, no narration, no move', lq.length === 1 && promptOf(lq[0]).includes('Which of these does \\"sideways\\" mean') && bm.kind === 'text' && /no exit or known place called "sideways"/.test(bm.mes) && (await stored()) === 'riverton:drowned_rat/common_room', lq.length + JSON.stringify(bm) + (await stored()) + promptOf(lq[0] ?? {}).slice(0, 400));
    rL = (await reqsNow()).length;
    await queue([{ content: 'You open the door.' }]);
    await send('I [open] out', 1);
    lq = (await reqsNow()).slice(rL); lk = await lastU();
    check('bracket [open] out: exact target, door opened, narration only', lq.length === 1 && lk.extra.worldscrawl_door?.type === 'open_door' && (await openDoors()) === 'common_room|out', lq.length + JSON.stringify(lk.extra) + await openDoors());
    rL = (await reqsNow()).length;
    await queue([{ content: 'You close the door.' }]);
    await send('I [close] the out', 1);
    lk = await lastU();
    check('bracket [close]: door closed again', (await reqsNow()).length - rL === 1 && lk.extra.worldscrawl_door?.type === 'close_door' && (await openDoors()) === '', JSON.stringify(lk.extra) + await openDoors());
    rL = (await reqsNow()).length;
    await send('/ws-help', 0);
    bm = await lastChatMsg();
    check('/ws-help: same verb list, no model call', (await reqsNow()).length === rL && bm.kind === 'text' && /\[open\]/.test(bm.mes), JSON.stringify(bm));
    // Ambiguous look: option 1 = around; no window option without window words (and no views here).
    rL = (await reqsNow()).length;
    await queue([{ content: 'look' }, { content: 'Around' }, { content: 'The room, in general.' }]);
    await send('I look at things for a while', 3);
    lq = (await reqsNow()).slice(rL); lk = await lastU();
    check('look: option around gives kind around, no stamp', lk.extra.worldscrawl_look?.kind === 'around' && !lk.extra.worldscrawl_change && promptOf(lq[1]).includes('- around: around here in general, nothing specific') && promptOf(lq[2]).includes('mention every exit listed above'), JSON.stringify(lk.extra));
    check('look: window option absent without window words', !promptOf(lq[1]).includes('out a window or opening'), promptOf(lq[1]).slice(-400));
    rL = (await reqsNow()).length;
    await queue([{ content: 'look' }, { content: 'out' }, { content: 'They peek.' }, { content: 'You peek outside.' }]);
    await send('I peek through the keyhole of the front door', 4);
    lq = (await reqsNow()).slice(rL); lk = await lastU();
    check('doors: closed-door question offers listen / peek / open / just looking', ['- listen: only listens', '- peek: peeks through it', '- open: opens it', '- look: just looks at the closed door'].every(x => promptOf(lq[2]).includes(x)), promptOf(lq[2]).slice(-400));
    check('doors: peek shows the room beyond but leaves the door shut, stamps a peek record', lk.extra.worldscrawl_look?.kind === 'see' && lk.extra.worldscrawl_look.peek === true && !lk.extra.worldscrawl_change && lk.extra.worldscrawl_peek?.type === 'peek' && lk.extra.worldscrawl_peek.door === 'out' && lk.extra.worldscrawl_peek.from === 'riverton:drowned_rat/common_room' && (await openDoors()) === '' && promptOf(lq[3]).includes('peeks through the closed door (out) without opening it') && promptOf(lq[3]).includes('The door stays closed'), JSON.stringify(lk.extra) + promptOf(lq[3]).slice(-400));
    rL = (await reqsNow()).length;
    await queue([{ content: 'look' }, { content: 'out' }, { content: 'look' }, { content: 'A sturdy door.' }]);
    await send('I look at the front door', 4);
    lq = (await reqsNow()).slice(rL); lk = await lastU();
    check('doors: just looking at a closed door: "the door is closed", nothing opened or peeked', lk.extra.worldscrawl_look?.kind === 'closed' && !lk.extra.worldscrawl_change && !lk.extra.worldscrawl_peek && (await openDoors()) === '' && promptOf(lq[3]).includes('The door is closed; nothing beyond it can be seen') && !promptOf(lq[3]).includes('sees Village Square'), JSON.stringify(lk.extra) + promptOf(lq[3]).slice(-400));
    rL = (await reqsNow()).length;
    await queue([{ content: 'look' }, { content: 'the out door' }, { content: 'OPEN' }, { content: 'You open it and look outside.' }]);
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
    await queue([{ content: 'look' }, { content: 'in' }, { content: 'listen' }, { content: 'Muffled voices.' }]);
    await send('I listen at the tavern door', 4);
    lq = (await reqsNow()).slice(rL); lk = await lastU();
    check('doors: listening at a closed door: faint hint only, nothing opened', lk.extra.worldscrawl_look?.kind === 'listen' && !lk.extra.worldscrawl_change && promptOf(lq[3]).includes('Only faint, muffled sounds') && !promptOf(lq[3]).includes('Looking in, you can see'), promptOf(lq[3]).slice(-500));
    // Obscured trapdoor: both rooms recorded (opaque tokens), so it stays open in the cellar and shuts once both are left.
    await go('in', 'back');
    rL = (await reqsNow()).length;
    await queue([{ content: 'look' }, { content: 'trapdoor' }, { content: 'look' }, { content: 'A stair into the dark.' }]);
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
    // ---- Barred doors: a map edit puts a bar on the courtyard side of the trapdoor; [bar]/[unbar] from that side.
    await go('back');
    const BAR_YARD = 'riverton:drowned_rat/courtyard';
    check('barred: in the courtyard', (await stored()) === BAR_YARD, String(await stored()));
    const barMsg = await page.evaluate(async yard => { const c = SillyTavern.getContext(); c.chat.push({ name: 'WorldScrawl', is_user: false, is_system: true, send_date: Date.now(), mes: 'Map edit: bar on the trapdoor',
        extra: { worldscrawl_patches: [{ type: 'patch', id: 'e2e_bar', note: 'bar', at: Date.now(), ops: [{ op: 'set_exit', loc: yard, direction: 'trapdoor', fields: { barrier: { barred_from: 'this_side' } } }] }] } }); await c.saveChat(); await c.reloadCurrentChat(); return c.chat.length - 1; }, BAR_YARD);
    await page.waitForTimeout(2500);
    const barState = () => M(m => [...m.barStates().values()].map(c => c.type).join(','));
    rL = (await reqsNow()).length;
    await queue([{ content: 'You lift the bar.' }]);
    await send('I [unbar] the trapdoor', 1);
    lq = (await reqsNow()).slice(rL); lk = await lastU();
    check('bracket [unbar]: no intent question, unbar_door stamped, narrator told', lq.length === 1 && lk.extra.worldscrawl_door?.type === 'unbar_door' && changesOfE(lk).map(c => c.type).join() === 'unbar_door' && promptOf(lq[0]).includes('unbars the trapdoor') && (await barState()) === 'unbar_door', lq.length + JSON.stringify(lk.extra) + (await barState()) + promptOf(lq[0] ?? {}).slice(-400));
    rL = (await reqsNow()).length;
    await queue([{ content: 'You drop the bar back in place.' }]);
    await send('I [bar] trapdoor', 1);
    lk = await lastU();
    check('bracket [bar]: bar_door stamped', (await reqsNow()).length - rL === 1 && lk.extra.worldscrawl_door?.type === 'bar_door' && (await barState()) === 'bar_door', JSON.stringify(lk.extra) + await barState());
    rL = (await reqsNow()).length;
    await send('I [bar] the trapdoor', 0);
    bm = await lastChatMsg();
    check('bracket [bar] on an already barred door: a clear note, no model call', (await reqsNow()).length === rL && bm.kind === 'text' && /already barred/.test(bm.mes), JSON.stringify(bm));
    await page.evaluate(() => SillyTavern.getContext().executeSlashCommandsWithOptions('/ws-unbar trapdoor')); await page.waitForTimeout(1000);
    check('/ws-unbar: lifted again', (await barState()) === 'unbar_door', await barState());
    const stuckFar = await M(m => m.isStuck({ door: 'x', barrier: { barred_from: 'other_side' } }, new Map(), new Map()));
    check('a door barred from the far side is stuck (will not open from here)', stuckFar === true);
    await page.evaluate(async id => { const c = SillyTavern.getContext(); c.chat.splice(id, 1); await c.saveChat(); await c.reloadCurrentChat(); }, barMsg);
    await page.waitForTimeout(2500);
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
    {
        const sp = await ui.$('.splitter'); const b = await sp.boundingBox(); const w0 = await ui.evaluate(() => document.querySelector('.side').getBoundingClientRect().width);
        await ui.mouse.move(b.x + 3, b.y + 50); await ui.mouse.down(); await ui.mouse.move(b.x - 120, b.y + 50, { steps: 4 }); await ui.mouse.up();
        const r = await ui.evaluate(() => ({ w: document.querySelector('.side').getBoundingClientRect().width, saved: localStorage.getItem('worldscrawl_sizes') }));
        check('map/panel splitter drags wider and persists the size', r.w > w0 + 60 && /side:/.test(r.saved ?? ''), JSON.stringify({ w0, ...r }));
        await sp.dblclick(); const w2 = await ui.evaluate(() => document.querySelector('.side').getBoundingClientRect().width);
        check('double-clicking the splitter resets the panel size', Math.abs(w2 - w0) < 3, `${w0} ${w2}`);
    }
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
    await ui.click('#breadcrumb .centerbtn'); await ui.waitForTimeout(300);
    check('Centre goes back to the current room\'s layer', (await ui.evaluate(() => document.querySelector('.node.here')?.dataset.id)) === m2.here);
    // Breadcrumbs: pills (the last one highlighted like a map node), no ⓘ, the Center button (icon + label) in its place.
    const bc = await ui.evaluate(() => { const cs = [...document.querySelectorAll('#breadcrumb .crumb')], st = x => getComputedStyle(x);
        return { n: cs.length, pill: cs.every(x => parseFloat(st(x).borderRadius) >= 8 && st(x).borderStyle !== 'none'), active: cs.at(-1)?.classList.contains('active') && st(cs.at(-1)).boxShadow !== 'none',
            info: /ⓘ/.test(document.getElementById('breadcrumb').textContent), center: document.querySelector('#breadcrumb .centerbtn')?.textContent ?? '', centerLast: document.getElementById('breadcrumb').lastElementChild?.classList.contains('centerbtn') }; });
    check('breadcrumb: pill crumbs, the current one highlighted, no ⓘ, "⌖ Center" in its place', bc.n === 3 && bc.pill && bc.active && !bc.info && /⌖\s*Center/.test(bc.center) && bc.centerLast, JSON.stringify(bc));
    // Clicking a crumb shows the level with that entity's contents and selects that entity (not the player's child of it).
    const pickOf = () => ui.evaluate(() => ({ sel: document.querySelector('.node.selected')?.dataset.id ?? null, h: document.querySelector('.side h3')?.textContent ?? '', area: document.querySelector('.side .area')?.textContent ?? '', crumbs: [...document.querySelectorAll('#breadcrumb .crumb')].map(x => x.textContent) }));
    await ui.click('#breadcrumb .crumb[data-level="region"]'); await ui.waitForTimeout(400);
    const pr = await pickOf(), prIds = await nodeIds();
    check('region crumb: shows the region\'s subregions and selects the region itself', prIds.every(i => i.startsWith('sub:riverton:')) && pr.sel === null && pr.h === pr.crumbs.at(-1) && /Region/.test(pr.area) && pr.crumbs.length === 2, JSON.stringify([pr, prIds]));
    await ui.click('#breadcrumb .crumb[data-level="world"]'); await ui.waitForTimeout(400);
    const pw = await pickOf();
    check('world crumb: shows the regions and selects the world', pw.sel === null && pw.h === 'World' && pw.crumbs.length === 1, JSON.stringify(pw));
    await ui.click('#breadcrumb .centerbtn'); await ui.waitForTimeout(300);
    await ui.click('#breadcrumb .crumb.active'); await ui.waitForTimeout(400);
    const plc = await pickOf();
    check('last crumb: stays on the current area and selects that area (not its parent, not the room)', plc.sel === null && plc.h === plc.crumbs.at(-1) && /Area/.test(plc.area) && plc.crumbs.length === 3, JSON.stringify(plc));
    await ui.click('#breadcrumb .centerbtn'); await ui.waitForTimeout(300);
    // Waiting / sleeping: /ws-wait stamps a message and advances the clock; the map's Wait picker asks this tab; delete undoes.
    const clockNow = () => page.evaluate(async () => (await import('/scripts/extensions/third-party/WorldScrawl/index.js')).chatElapsed());
    const t0 = await clockNow(), hereBefore = await stored();
    expected += 1; await page.evaluate(() => SillyTavern.getContext().executeSlashCommandsWithOptions('/ws-wait 2h')); await waitReqs();
    check('/ws-wait 2h: clock +2h, no move', (await clockNow()) - t0 === 7200 && (await stored()) === hereBefore, `${(await clockNow()) - t0}`);
    const wq = await page.evaluate(() => { const ch = SillyTavern.getContext().chat; const u = ch.filter(m => m.is_user).pop(); return { mes: u.mes, w: u.extra.worldscrawl_wait }; });
    check('/ws-wait: stamped user message', /waits for 2h/.test(wq.mes) && wq.w?.seconds === 7200, JSON.stringify(wq));
    const lastBody = async () => JSON.stringify((await (await fetch(`${FAKE}/__requests`)).json()).pop());
    check('/ws-wait: narrator told how long and the new time', /waited here for 2h/.test(await lastBody()));
    // Game-time labels: on every narrator message, live from the clock, with the elapsed time after the wait.
    const tlabels = () => page.evaluate(() => { const ch = SillyTavern.getContext().chat; let n = ch.length - 1; while (n >= 0 && (ch[n].is_user || ch[n].is_system)) n--; return { n, last: document.querySelector(`#chat .mes[mesid="${n}"] .worldscrawl_time`)?.textContent ?? '', count: document.querySelectorAll('#chat .worldscrawl_time').length, narr: [...document.querySelectorAll('#chat .mes[mesid]')].filter(el => { const m = ch[Number(el.getAttribute('mesid'))]; return m && !m.is_user && !m.is_system && !m.extra?.worldscrawl_notice; }).length, stored: JSON.stringify(ch).includes('worldscrawl_time') }; });
    try { await page.waitForFunction(() => /\+2h/.test(document.querySelector('#chat .mes:last-child .worldscrawl_time')?.textContent ?? ''), null, { timeout: 5000 }); } catch {}
    const tl = await tlabels();
    check('game-time labels on every narrator message, +2h after the wait, nothing stored', tl.count > 0 && tl.count === tl.narr && /\d:\d\d [AP]M \(\+2h\)/.test(tl.last) && !tl.stored, JSON.stringify(tl));
    const relabel = await page.evaluate(async () => { const c = SillyTavern.getContext(); const u = c.chat.filter(m => m.is_user && m.extra?.worldscrawl_wait?.seconds === 7200).pop(); u.extra.worldscrawl_wait.seconds = 3600; await c.eventSource.emit(c.eventTypes.MESSAGE_UPDATED, c.chat.indexOf(u)); await new Promise(r => setTimeout(r, 1500)); const t = document.querySelector('#chat .mes:last-child .worldscrawl_time')?.textContent ?? ''; u.extra.worldscrawl_wait.seconds = 7200; await c.eventSource.emit(c.eventTypes.MESSAGE_UPDATED, c.chat.indexOf(u)); await new Promise(r => setTimeout(r, 1500)); return { edited: t, back: document.querySelector('#chat .mes:last-child .worldscrawl_time')?.textContent ?? '' }; });
    check('game-time labels follow an edited earlier wait', /\(\+1h\)/.test(relabel.edited) && /\(\+2h\)/.test(relabel.back), JSON.stringify(relabel));
    const cn = await page.evaluate(() => { const ch = SillyTavern.getContext().chat; const m = ch.filter(x => !x.is_user && !x.is_system).pop(); return m?.extra?.worldscrawl_calls?.[m.swipe_id ?? 0] ?? null; });
    check('model-call notes: the narrator reply is noted (what it emitted, or no tool call)', Array.isArray(cn) && cn.some(n => n.kind === 'narrator reply' && (n.emitted?.length || n.reason === 'narrator made no tool call')), JSON.stringify(cn));
    // A narrator generation that fails outright: noted on the player's message that triggered it.
    await queue([{ content: 'stay' }, { error: 'fake model is down' }, { error: 'fake model is down' }]);
    await send('I hum a tune quietly.');
    const nf = await page.evaluate(async () => {
        const c = SillyTavern.getContext(), i = c.chat.length - 1, m = c.chat[i];
        const { messageActivity } = await import('/scripts/extensions/third-party/WorldScrawl/activity.mjs');
        return { user: !!m.is_user, notes: m.extra?.worldscrawl_calls?.[m.swipe_id ?? 0] ?? null, act: messageActivity(m, i).filter(e => e.kind === 'call').map(e => `${e.label}: ${e.status} ${e.reason ?? ''}`) };
    });
    check('a failed narrator generation is noted on the player message (kind narrator, failed, reason) and shown in the activity log', nf.user && nf.notes?.some(n => n.kind === 'narrator' && n.status === 'failed' && /fake model is down|error|no reply/.test(n.reason ?? '')) && nf.act.some(t => /^narrator: failed/.test(t)), JSON.stringify(nf));
    await queue([]);
    await page.evaluate(async () => { const c = SillyTavern.getContext(); if (c.chat[c.chat.length - 1]?.is_user) await c.executeSlashCommandsWithOptions('/cut ' + (c.chat.length - 1)); });
    await page.waitForTimeout(1000);
    const t1 = await clockNow();
    expected += 1; await ui.selectOption('#waitPick', 'sleep|8h'); await waitReqs();
    check('map Wait picker: sleep 8h via the chat tab', (await clockNow()) - t1 === 8 * 3600, `${(await clockNow()) - t1}`);
    check('sleep: narrator told to wake up', /slept here for 8h/.test(await lastBody()));
    try { await ui.waitForFunction(() => /slept 8h/.test(document.getElementById('status')?.textContent ?? ''), null, { timeout: 5000 }); } catch {}
    check('map clock shows the wait', /slept 8h/.test(await ui.evaluate(() => document.getElementById('status')?.textContent ?? '')));
    const t2 = await clockNow();
    expected += 1; await page.evaluate(() => SillyTavern.getContext().executeSlashCommandsWithOptions('/ws-wait until midnight')); await waitReqs();
    const dm = await page.evaluate(async () => { const m = await import('/scripts/extensions/third-party/WorldScrawl/index.js'); return m.gameDate(); });
    check('/ws-wait until midnight lands on 00:00', (await clockNow()) > t2 && dm?.time === '00:00', JSON.stringify(dm));
    await page.evaluate(async () => { const c = SillyTavern.getContext(); const i = c.chat.findLastIndex(m => m.is_user && m.extra?.worldscrawl_wait); await c.executeSlashCommandsWithOptions(`/cut ${i}-${c.chat.length - 1}`); });
    check('deleting the wait message undoes it', (await clockNow()) === t2, `${await clockNow()} vs ${t2}`);
    check('non-tools mode tells the narrator about [ws_wait] tags', (await (await fetch(`${FAKE}/__requests`)).json()).some(r => !r.tools?.length && JSON.stringify(r.messages).includes('[ws_wait: sleep until morning')));
    // ---- Editing a proposed map change before Keep, re-editing a kept one, and "Edit live" from the map window.
    const CR = 'riverton:drowned_rat/common_room';
    const wsMod = '/scripts/extensions/third-party/WorldScrawl/index.js';
    const flagId = await page.evaluate(async ([CR, mod]) => {
        const c = SillyTavern.getContext(), id = c.chat.findLastIndex(m => !m.is_system && !m.is_user);
        c.chat[id].extra = c.chat[id].extra ?? {};
        c.chat[id].extra.worldscrawl_flag = { status: 'review', start: id, swipe: c.chat[id].swipe_id ?? 0, note: 'fire', proposal: { ops: [{ op: 'set_description', loc: CR, text: 'Smoky.' }], summary: ['Common Room: description rewritten'], relocate: {}, before: { [CR]: { name: 'Common Room', description: 'Warm and loud.' } }, after: { [CR]: { name: 'Common Room', description: 'Smoky.' } } } };
        (await import(mod)).renderPatchCards(); return id;
    }, [CR, wsMod]);
    const card = page.locator(`#chat .mes[mesid="${flagId}"] .worldscrawl_patchcard`);
    await card.locator('.wsdiff-del').first().waitFor({ timeout: 10000 });
    const diffLook = () => card.evaluate(c => { const bg = s => s ? getComputedStyle(s).backgroundColor : ''; const d = c.querySelector('.wsdiff-del'), i = c.querySelector('.wsdiff-ins'); return { del: d?.textContent ?? '', ins: i?.textContent ?? '', dbg: bg(d), ibg: bg(i), json: !!c.querySelector('.wsdiff pre'), raw: [...c.querySelectorAll('.wsdiff-toggle')].map(t => t.textContent).join('|') }; });
    const dl1 = await diffLook();
    check('review card: description change shows red removed / green added blocks (no JSON dump up front)', dl1.del.includes('Warm and loud.') && dl1.ins.includes('Smoky.') && /rgba\(200, 60, 60/.test(dl1.dbg) && /rgba\(60, 160, 90/.test(dl1.ibg) && /Raw JSON/.test(dl1.raw), JSON.stringify(dl1));
    await card.locator('.worldscrawl_card_btn', { hasText: /^Edit$/ }).click();
    await card.locator('.wspf-op').first().waitFor({ timeout: 10000 });
    check('review card: Edit opens the change as a form (description textarea prefilled)', await card.locator('.wspf-text').first().inputValue() === 'Smoky.');
    const pick = await card.evaluate(c => { const sel = c.querySelector('.wspf-op select.wspf-pick'); return sel ? sel.selectedOptions[0]?.textContent : null; });
    check('review card: the place is a picker with a friendly name, not a raw address box', /^Common Room \(/.test(pick ?? ''), String(pick));
    await card.locator('.wspf-text').first().fill('');
    await card.locator('.worldscrawl_card_btn', { hasText: 'Approve edited' }).click(); await page.waitForTimeout(800);
    check('review card: an empty description is refused inline, nothing stamped', /text/i.test(await card.innerText()) && await page.evaluate(id => !SillyTavern.getContext().chat[id].extra.worldscrawl_patches, flagId), await card.innerText());
    await card.locator('.wspf-text').first().fill('Charred beams and ash.');
    await page.waitForFunction(id => document.querySelector(`#chat .mes[mesid="${id}"] .worldscrawl_patchcard .wsdiff-ins`)?.textContent.includes('Charred beams'), flagId, { timeout: 10000 }).catch(() => {});
    const dl2 = { ...(await diffLook()), dbgBox: await card.evaluate(c => { const b = c.querySelector('.worldscrawl_diff'); return b ? [b.style.opacity, b.title, c.querySelector('.wspf-text')?.value] : null; }) };
    check('review card: the diff follows the form live, before Keep', dl2.ins.includes('Charred beams and ash.') && !dl2.ins.includes('Smoky.'), JSON.stringify(dl2));
    await card.locator('.worldscrawl_card_btn', { hasText: 'Approve edited' }).click(); await page.waitForTimeout(1500);
    const kept1 = await page.evaluate(id => SillyTavern.getContext().chat[id].extra.worldscrawl_patches, flagId);
    check('review card: Keep stamps exactly the edited change', kept1?.length === 1 && kept1[0].ops.length === 1 && kept1[0].ops[0].text === 'Charred beams and ash.', JSON.stringify(kept1));
    // Edit on a kept change opens the map editor in its own tab: one tab per touched place, place forms, no op dropdown.
    const edTab = page.context().waitForEvent('page', { timeout: 15000 });
    await card.locator('.worldscrawl_card_btn', { hasText: /^Edit$/ }).click();
    const ed = await edTab;
    const edErrors = []; ed.on('pageerror', e => { edErrors.push(e.message); console.log('[editor pageerror]', e.message); });
    await ed.waitForSelector('.change-editor .ce-place', { timeout: 20000 }).catch(() => {});
    const ed0 = await ed.evaluate(() => ({ url: location.search, tabs: [...document.querySelectorAll('.ce-tab')].map(t => t.dataset.target), desc: document.querySelector('.ce-place .placeform > .pf-row[data-field="description"] textarea')?.value, opSelect: !!document.querySelector('.wspf-op'), raw: !!document.querySelector('.ce-raw-box textarea') }));
    check('kept change Edit: opens the editor tab for this message\'s change, one tab per touched place, place form starts after the change, no op dropdown, Raw JSON there', /edit=1/.test(ed0.url) && new RegExp(`msg=${flagId}`).test(ed0.url) && ed0.tabs.length === 1 && ed0.tabs[0] === CR && ed0.desc === 'Charred beams and ash.' && !ed0.opSelect && ed0.raw, JSON.stringify(ed0));
    await ed.fill('.ce-place .placeform > .pf-row[data-field="description"] textarea', 'Rebuilt, smelling of fresh pine.');
    await ed.waitForTimeout(800);
    await ed.click('.ce-save');
    try { await ed.waitForFunction(() => /Saved on message/.test(document.querySelector('.ce-status')?.textContent ?? ''), null, { timeout: 10000 }); } catch {}
    const kept2 = await page.evaluate(id => SillyTavern.getContext().chat[id].extra.worldscrawl_patches, flagId);
    check('editor tab Save: the SillyTavern tab re-stamps the change on the same message', kept2?.length === 1 && kept2[0].id === kept1[0].id && kept2[0].ops.at(-1).text === 'Rebuilt, smelling of fresh pine.', JSON.stringify(kept2) + await ed.evaluate(() => document.querySelector('.change-editor')?.innerText.slice(-300)));
    await page.evaluate(id => { const p = SillyTavern.getContext().chat[id].extra.worldscrawl_patches[0]; p.ops = [{ ...p.ops.at(-1), text: 'Changed in the chat meanwhile.' }]; }, flagId);
    await ed.click('.ce-save');
    try { await ed.waitForFunction(() => /Not saved/.test(document.querySelector('.ce-status')?.textContent ?? ''), null, { timeout: 10000 }); } catch {}
    const edStale = await ed.evaluate(() => document.querySelector('.change-editor')?.innerText ?? '');
    const kept3 = await page.evaluate(id => SillyTavern.getContext().chat[id].extra.worldscrawl_patches, flagId);
    check('editor tab Save refused with a note when the change was edited since it opened', /edited since/.test(edStale) && kept3[0].ops.length === 1 && kept3[0].ops[0].text === 'Changed in the chat meanwhile.', edStale.slice(-300) + JSON.stringify(kept3));
    check('editor tab: no page errors', !edErrors.length, edErrors.join(' | '));
    await ed.close();
    await card.locator('.worldscrawl_card_btn', { hasText: 'Undo' }).click(); await page.waitForTimeout(1000);
    check('Undo removes the edited change', await page.evaluate(id => !SillyTavern.getContext().chat[id].extra.worldscrawl_patches, flagId));
    // Edit live from the map window's inspector.
    await ui.click('#editorToggle'); await ui.waitForTimeout(800);
    await ui.click(`.node[data-id="${CR}"]`);
    await ui.locator('.side .editlive').waitFor({ timeout: 10000 });
    const descRow = () => ui.evaluate(() => { const tr = [...document.querySelectorAll('.side table.resolved tr')].find(r => r.querySelector('th')?.textContent === 'description'); return tr ? [tr.querySelector('.val')?.textContent ?? '', tr.querySelector('.src')?.textContent ?? ''] : null; });
    const dr0 = await descRow();
    check('inspector Resolved shows the room\'s own description, from file', dr0 && dr0[0].length > 10 && /from file/.test(dr0[1] ?? dr0.join('')), JSON.stringify(dr0));
    const nLiveEdit = await page.evaluate(() => SillyTavern.getContext().chat.length);
    check('room inspector button reads "Edit place"', (await ui.locator('.side .editlive').textContent()) === 'Edit place');
    await ui.click('.side .editlive');
    const descIn = ui.locator('.side .placeform > .pf-row[data-field="description"] textarea');
    await descIn.waitFor({ timeout: 10000 });
    const pf0 = await ui.evaluate(() => { const f = document.querySelector('.side .placeform'), r = k => f.querySelector(`.pf-row[data-field="${k}"]`);
        return { name: r('name').querySelector('input').value, exp: r('exposure').classList.contains('inherited'), expTag: r('exposure').querySelector('.pf-from')?.textContent, expandable: r('expandable').querySelector('input').type,
            radios: r('insulation').querySelectorAll('input[type=radio]').length, select: !!r('exposure').querySelector('select'), move: r('move').querySelector('.wspick')?.value, movePath: r('move').querySelector('.wspick-value')?.textContent,
            exits: f.querySelectorAll('.pf-exit').length, collapsed: [...f.querySelectorAll('.pf-exit-body')].every(b => b.hidden), ops: !!document.querySelector('.side select.wspf-op') }; });
    check('Edit place: a form with the place\'s data (inputs, checkbox, radios for 3 options, dropdown for 4+, move dropdown, collapsed exits)', pf0.name === 'Common Room' && pf0.expandable === 'checkbox' && pf0.radios === 3 && pf0.select && pf0.move === 'riverton:drowned_rat' && / › /.test(pf0.movePath) && pf0.exits === 3 && pf0.collapsed && !pf0.ops, JSON.stringify(pf0));
    check('Edit place: inherited fields are greyed with a "from subregion" tag', pf0.exp && pf0.expTag === 'from subregion', JSON.stringify(pf0));
    await descIn.fill('Burned to the rafters.');
    try { await ui.waitForFunction(() => /Burned to the rafters/.test(document.querySelector('.side .editlive-diff')?.innerText ?? ''), null, { timeout: 8000 }); } catch {}
    check('Edit place: the red/green diff shows the change before Submit', /Burned to the rafters/.test(await ui.evaluate(() => document.querySelector('.side .editlive-diff')?.innerText ?? '')));
    // Cast and Editor share the side pane: opening one closes the other, and the unsaved place form comes back intact.
    await ui.click('#castToggle'); await ui.waitForTimeout(1200);
    const cxSw1 = await ui.evaluate(() => ({ casting: document.body.classList.contains('casting'), editor: document.body.classList.contains('editor'), cast: !!document.querySelector('.side .castpanel'), form: !!document.querySelector('.side .placeform'), w: Math.round(document.querySelector('.side').getBoundingClientRect().width), draft: globalThis.wsSideDraft?.() }));
    check('opening Cast while editing: Editor turns off, Cast fills the side pane (no form underneath), draft kept', cxSw1.casting && !cxSw1.editor && cxSw1.cast && !cxSw1.form && cxSw1.w >= 370 && cxSw1.draft, JSON.stringify(cxSw1));
    await ui.click('#editorToggle'); await ui.waitForTimeout(1200);
    const cxSw2 = await ui.evaluate(() => ({ casting: document.body.classList.contains('casting'), editor: document.body.classList.contains('editor'), cast: !!document.querySelector('.side .castpanel'), desc: document.querySelector('.side .placeform > .pf-row[data-field="description"] textarea')?.value, w: Math.round(document.querySelector('.side').getBoundingClientRect().width) }));
    check('opening Editor from Cast: Cast turns off and the unsaved Edit place form is restored', !cxSw2.casting && cxSw2.editor && !cxSw2.cast && cxSw2.desc === 'Burned to the rafters.' && cxSw2.w >= 370, JSON.stringify(cxSw2));
    await ui.click('.side button.pf-submit');
    try { await ui.waitForFunction(() => /Saved as message/.test(document.querySelector('.side')?.innerText ?? ''), null, { timeout: 10000 }); } catch {}
    const le = await page.evaluate(n => { const c = SillyTavern.getContext(), m = c.chat[c.chat.length - 1]; return { grew: c.chat.length === n + 1, sys: m.is_system, mes: m.mes, p: m.extra?.worldscrawl_patches }; }, nLiveEdit);
    check('GUI Edit place: SillyTavern adds a hidden system message carrying the stamp', le.grew && le.sys === true && /^Map edit: /.test(le.mes) && le.p?.[0]?.ops?.[0]?.text === 'Burned to the rafters.', JSON.stringify(le));
    check('Edit place: only the changed field became an op (no inherited values copied in)', le.p?.[0]?.ops?.length === 1 && le.p[0].ops[0].op === 'set_description', JSON.stringify(le.p?.[0]?.ops));
    try { await ui.waitForSelector(`.node.patched[data-id="${CR}"]`, { timeout: 10000 }); } catch {}
    check('map marks the patched room', await ui.locator(`.node.patched[data-id="${CR}"] .patchdot`).count() === 1);
    await ui.click(`.node[data-id="${CR}"]`); await ui.waitForTimeout(1500);
    const dr1 = await descRow();
    check('Resolved is live: the new description, tagged with its message', dr1 && dr1[0] === 'Burned to the rafters.' && dr1.join(' ').includes(`from message #${nLiveEdit}`), JSON.stringify(dr1));
    const told = await page.evaluate(async mod => (await import(mod)).chatElapsed !== undefined, wsMod);
    await page.evaluate(n => SillyTavern.getContext().executeSlashCommandsWithOptions(`/cut ${n}`), nLiveEdit); await page.waitForTimeout(1500);
    try { await ui.waitForFunction(id => !document.querySelector(`.node.patched[data-id="${id}"]`), CR, { timeout: 10000 }); } catch {}
    check('deleting the map-edit message undoes it (marker gone)', told && await ui.locator(`.node.patched[data-id="${CR}"]`).count() === 0 && await page.evaluate(() => !SillyTavern.getContext().chat.some(m => m.extra?.worldscrawl_patches)));
    // Edit place: inherited checkbox + reset, exit blocks (collapse/expand, X removes the pair, Add exit), per-side vs shared.
    await ui.click(`.node[data-id="${CR}"]`); await ui.waitForTimeout(1200);
    const nPf = await page.evaluate(() => SillyTavern.getContext().chat.length);
    await ui.click('.side .editlive');
    await ui.locator('.side .placeform .pf-exit').first().waitFor({ timeout: 10000 });
    await ui.click('.side .pf-expand');
    const allOpen = await ui.evaluate(() => [...document.querySelectorAll('.side .pf-exit-body')].every(b => !b.hidden));
    await ui.click('.side .pf-collapse');
    const allShut = await ui.evaluate(() => [...document.querySelectorAll('.side .pf-exit-body')].every(b => b.hidden));
    check('Edit place: Expand all / Collapse all toggle every exit block', allOpen && allShut);
    const expRow = '.side .placeform > .pf-row[data-field="expandable"]';
    await ui.click(`${expRow} input`);
    const ex1 = await ui.evaluate(r => { const e = document.querySelector(r); return { inh: e.classList.contains('inherited'), reset: !e.querySelector('.pf-reset').hidden, on: e.querySelector('input').checked }; }, expRow);
    await ui.click(`${expRow} .pf-reset`);
    const ex2 = await ui.evaluate(r => { const e = document.querySelector(r); return { inh: e.classList.contains('inherited'), reset: !e.querySelector('.pf-reset').hidden, on: e.querySelector('input').checked, tag: e.querySelector('.pf-from')?.textContent }; }, expRow);
    check('Edit place: overriding an inherited checkbox shows a reset button; reset goes back to the greyed inherited value', !ex1.inh && ex1.reset && ex1.on === false && ex2.inh && !ex2.reset && ex2.on === true && ex2.tag === 'default', JSON.stringify([ex1, ex2]));
    await ui.click(`${expRow} input`); // off again: stays overridden
    const block = dir => ui.locator('.side .pf-exit', { has: ui.locator(`.pf-exit-title:text-matches("^${dir} →")`) });
    await block('up').locator('.pf-x').click();
    await block('out').locator('.pf-toggle').click();
    await block('out').locator('.pf-side[data-side="there"] .pf-row[data-field="sight"] input[value="clear"]').check();
    const outDoor = await block('out').locator('.pf-row[data-field="door"] input').isChecked();
    await ui.click('.side .pf-addexit');
    const newBlk = ui.locator('.side .pf-exit').first();
    await newBlk.locator('.pf-dir[data-field="direction"]').fill('side door');
    await pickSet(newBlk.locator('.pf-row[data-field="to"] .wspick'), 'riverton:streets/market_lane');
    await newBlk.locator('.pf-dir[data-field="back_direction"]').fill('tavern');
    const nbTitle = await newBlk.locator('.pf-exit-title').textContent();
    await ui.click('.side button.pf-submit');
    try { await ui.waitForFunction(() => /Saved as message/.test(document.querySelector('.side')?.innerText ?? ''), null, { timeout: 10000 }); } catch {}
    const pfOps = await page.evaluate(n => { const c = SillyTavern.getContext(); return c.chat.length === n + 1 ? c.chat[n].extra?.worldscrawl_patches?.[0]?.ops : null; }, nPf);
    const byOp = k => (pfOps ?? []).filter(o => o.op === k);
    check('Edit place: the door field shows the shared door; a new block reads its name and destination', outDoor && nbTitle === 'side door → Market Lane', nbTitle);
    check('Edit place Submit: expandable false, X → remove_exit, a per-side sight change → set_exit, Add exit → add_exit (nothing else)',
        pfOps?.length === 4 && byOp('set_expandable')[0]?.value === false && byOp('remove_exit')[0]?.direction === 'up' && JSON.stringify(byOp('set_exit')[0]?.fields) === '{"sight":"clear"}'
        && byOp('add_exit')[0]?.to === 'riverton:streets/market_lane' && byOp('add_exit')[0]?.return_direction === 'tavern', JSON.stringify(pfOps));
    await page.evaluate(n => SillyTavern.getContext().executeSlashCommandsWithOptions(`/cut ${n}`), nPf); await page.waitForTimeout(1500);
    // Edit live on a region / subregion page: rename via update_area, stamped on a hidden message, tagged in Resolved.
    await ui.click('#breadcrumb .crumb.active'); await ui.waitForTimeout(1200);
    const areaKind = await ui.evaluate(() => document.querySelector('.side .area')?.textContent ?? '');
    const nameRow = () => ui.evaluate(() => { const tr = [...document.querySelectorAll('.side table.resolved tr')].find(r => r.querySelector('th')?.textContent === 'name'); return tr ? { v: tr.querySelector('.val')?.textContent ?? '', src: tr.querySelector('.src')?.textContent ?? '', mark: !!tr.querySelector('.patchmark') } : null; });
    const an0 = await nameRow();
    check('area inspector has an Edit live button and an unmarked name row', /^(sub)?region/.test(areaKind) && await ui.locator('.side .editlive').count() === 1 && an0 && !an0.mark, areaKind + JSON.stringify(an0));
    const nArea = await page.evaluate(() => SillyTavern.getContext().chat.length);
    await ui.click('.side .editlive');
    const nameIn = ui.locator('.side .placeform > .pf-row[data-field="name"] input').first();
    await nameIn.waitFor({ timeout: 10000 });
    const areaForm = await ui.evaluate(() => ({ kind: document.querySelector('.side .placeform')?.dataset.kind, btn: document.querySelector('.side .editlive')?.textContent, notes: !!document.querySelector('.side .placeform .pf-row[data-field="lore"] textarea'), stays: document.querySelector('.side .placeform .pf-row[data-field="stays_open"] .pf-from')?.textContent ?? null, staysReset: document.querySelector('.side .placeform .pf-row[data-field="stays_open"] .pf-reset')?.hidden === false, regionNote: !!document.querySelector('.side .placeform .pf-parent-note[data-from="region"]') }));
    check('area Edit form: same style, prefilled with the live name, notes textarea, defaults tagged', (await nameIn.inputValue()) === an0.v && /^(sub)?region$/.test(areaForm.kind) && /^Edit (sub)?region$/.test(areaForm.btn) && areaForm.notes && areaForm.stays === null && !areaForm.staysReset, await nameIn.inputValue() + JSON.stringify(areaForm));
    await nameIn.fill('The Gilded Quarter');
    try { await ui.waitForFunction(() => /Gilded Quarter/.test(document.querySelector('.side .editlive-diff')?.innerText ?? ''), null, { timeout: 8000 }); } catch {}
    check('area Edit live: the red/green diff shows the rename', /Gilded Quarter/.test(await ui.evaluate(() => document.querySelector('.side .editlive-diff')?.innerText ?? '')));
    await ui.click('.side button.pf-submit');
    try { await ui.waitForFunction(() => /Saved as message/.test(document.querySelector('.side')?.innerText ?? ''), null, { timeout: 10000 }); } catch {}
    const ae = await page.evaluate(n => { const c = SillyTavern.getContext(), m = c.chat[c.chat.length - 1]; return { grew: c.chat.length === n + 1, sys: m.is_system, mes: m.mes, op: m.extra?.worldscrawl_patches?.[0]?.ops?.[0] }; }, nArea);
    check('area Edit live: hidden stamped message with update_area', ae.grew && ae.sys === true && /^Map edit: /.test(ae.mes) && ae.op?.op === 'update_area' && ae.op?.name === 'The Gilded Quarter' && !('lore' in ae.op), JSON.stringify(ae));
    await ui.waitForTimeout(1500);
    for (let k = 0; k < 4; k++) { // the map re-renders after the stamp; reopen the area page once it settles
        await ui.click('#breadcrumb .crumb.active'); await ui.waitForTimeout(1000);
        if ((await nameRow())?.v === 'The Gilded Quarter') break;
    }
    const an1 = await nameRow();
    check('area Resolved: renamed, tagged with its message, orange marker', an1 && an1.v === 'The Gilded Quarter' && an1.src.includes(`from message #${nArea}`) && an1.mark, JSON.stringify(an1));
    await page.evaluate(n => SillyTavern.getContext().executeSlashCommandsWithOptions(`/cut ${n}`), nArea); await page.waitForTimeout(1500);
    // ---- Map wizards (PR B): cascade on the last place (Confirm / Cancel / Add a place first), Move with an id clash
    // (rename prefilled), Delete subregion moving its places (= merge), Create region with Expand with AI, start region.
    const mwLastMsg = n => page.evaluate(n => { const c = SillyTavern.getContext(), m = c.chat[c.chat.length - 1]; const ps = m.extra?.worldscrawl_patches ?? []; return { grew: c.chat.length > n || ps.length > 1, sys: m.is_system, ops: ps.at(-1)?.ops ?? [], n: c.chat.length }; }, n); // a run of edits shares one carrier
    const mwSavedWait = async () => { try { await ui.waitForFunction(() => /Saved as message/.test(document.querySelector('.side .mapaction')?.innerText ?? ''), null, { timeout: 10000 }); } catch {} };
    const mwCut = async n => { await page.evaluate(n => SillyTavern.getContext().executeSlashCommandsWithOptions(`/cut ${n}-${SillyTavern.getContext().chat.length - 1}`), n); await page.waitForTimeout(1500); };
    const mwAct = async (target, action) => { await ui.evaluate(t => globalThis.wsInspect(t), target); await ui.locator(`.side .mapact[data-action="${action}"]`).waitFor({ timeout: 10000 }); await ui.click(`.side .mapact[data-action="${action}"]`); await ui.locator(`.side .mapaction[data-action], .side .editlive-pane`).first().waitFor({ timeout: 10000 }); };
    // No form or wizard prints "null" for a missing tag, reset or button (Edit region/subregion/place and every wizard).
    const nullHits = [];
    const sideText = () => ui.evaluate(() => document.querySelector('.side')?.innerText ?? '');
    for (const t of ['region:riverton', 'sub:riverton:drowned_rat', 'riverton:drowned_rat/common_room']) {
        await ui.evaluate(x => globalThis.wsInspect(x), t); await ui.locator('.side .editlive').waitFor({ timeout: 10000 }); await ui.click('.side .editlive');
        await ui.locator('.side .placeform').waitFor({ timeout: 10000 }); await ui.waitForTimeout(300);
        if (/\bnull\b/.test(await sideText())) nullHits.push(`edit ${t}`);
        if (t.includes('/')) { const empty = await ui.evaluate(() => [...document.querySelectorAll('.side .pf-exit .pf-radios')].filter(g => !g.querySelector('input:checked')).map(g => g.closest('.pf-row')?.dataset.field));
            check('Edit place: every exit radio group (type, See/Hear destination) has the effective value selected', !empty.length, JSON.stringify(empty));
            const why = await ui.evaluate(() => document.querySelector('.side .pf-exit .pf-row[data-field="sight"] .pf-from')?.textContent ?? '');
            check('Edit place: See destination shows a default/set-here tag', why === 'default' || why === 'set here', why);
            const doorLabels = await ui.evaluate(() => { const b = [...document.querySelectorAll('.side .pf-exit')].find(x => x.querySelector('.pf-door .pf-row[data-field="closed_sight"]')); return b ? [...b.querySelectorAll('.pf-sense-head, .pf-row[data-field="sight"] .pf-label, .pf-row[data-field="sound"] .pf-label, .pf-door .pf-row[data-field^="closed_"] .pf-label')].map(r => r.textContent) : null; });
            check('Edit place: with a door, "Sense transparency – unblocked" on each side and "– blocked" in the Door block', JSON.stringify(doorLabels) === JSON.stringify(['Sense transparency – unblocked', 'See destination', 'Hear destination', 'Sense transparency – unblocked', 'See destination', 'Hear destination', 'Sense transparency – blocked', 'See destination', 'Hear destination']), JSON.stringify(doorLabels));
            const plainHead = await ui.evaluate(() => [...document.querySelectorAll('.side .pf-exit')].find(x => !x.querySelector('.pf-door .pf-row'))?.querySelector('.pf-sense-head')?.textContent ?? null);
            check('Edit place: without a door the heading is just "Sense transparency"', plainHead === null || plainHead === 'Sense transparency', plainHead); }
    }
    for (const [t, a] of [['world', 'create_region'], ['region:riverton', 'create_subregion'], ['sub:riverton:drowned_rat', 'create_place'], ['sub:riverton:drowned_rat', 'merge_places'],
        ['sub:riverton:drowned_rat', 'delete_subregion'], ['sub:riverton:drowned_rat', 'move_subregion'], ['riverton:drowned_rat/common_room', 'move_place']]) {
        try { await mwAct(t, a); await ui.waitForTimeout(300); if (/\bnull\b/.test(await sideText())) nullHits.push(`${a} on ${t}`); } catch (e) { nullHits.push(`${a} on ${t}: ${e.message.split('\n')[0]}`); }
    }
    check('no edit form or wizard contains the text "null"', !nullHits.length, JSON.stringify(nullHits));
    const mwFORGE = 'riverton:smithy/forge';
    let mwNW = await page.evaluate(() => SillyTavern.getContext().chat.length);
    await ui.evaluate(() => globalThis.wsInspect('sub:riverton:smithy')); await ui.locator('.side .mapact[data-action="create_place"]').waitFor({ timeout: 10000 });
    const mwSubBtns = await ui.evaluate(() => [...document.querySelectorAll('.side .mapact')].map(b => b.textContent));
    check('subregion inspector: Create place, Merge places, Move subregion, Delete subregion beside Edit', JSON.stringify(mwSubBtns) === JSON.stringify(['Create place', 'Merge places', 'Move subregion', 'Delete subregion']), JSON.stringify(mwSubBtns));
    await mwAct(mwFORGE, 'delete_place');
    const mwCasc = await ui.evaluate(() => ({ t: document.querySelector('.side .mw-cascade')?.textContent ?? '', b: [...document.querySelectorAll('.side .mapaction button')].map(b => b.textContent) }));
    check('Delete the last place: required cascade warning with Confirm / Cancel / Add a place first', /Deleting the last place in Brask's Smithy will also delete Brask's Smithy/.test(mwCasc.t) && ['Confirm', 'Cancel', 'Add a place first'].every(x => mwCasc.b.includes(x)), JSON.stringify(mwCasc));
    await ui.click('.side .mw-addfirst');
    // Create place is the Edit place form, empty: every field, both sides of each exit named, one Door block.
    await ui.locator('.side .editlive-pane[data-mode="create"]').waitFor({ timeout: 10000 });
    const cpForm = await ui.evaluate(() => { const p = document.querySelector('.side .editlive-pane'); return { h: p.querySelector('h4')?.textContent, fields: [...p.querySelectorAll('.placeform > .pf-row')].map(r => r.dataset.field), sides: [...p.querySelectorAll('.pf-exit .pf-side')].map(s => s.dataset.side), doors: p.querySelectorAll('.pf-exit .pf-door').length, rz: getComputedStyle(p.querySelector('textarea')).resize }; });
    check('Create place: the Edit place form, empty, with both exit sides, one Door block and vertical-only text boxes',
        /Create place in Brask's Smithy/.test(cpForm.h) && ['name', 'description', 'exposure'].every(f => cpForm.fields.includes(f)) && JSON.stringify(cpForm.sides) === '["there","back"]' && cpForm.doors === 1 && cpForm.rz === 'vertical', JSON.stringify(cpForm));
    await ui.fill('.side .placeform > .pf-row[data-field="name"] input', 'Coal Shed');
    await ui.fill('.side .placeform > .pf-row[data-field="description"] textarea', 'Sacks of coal.');
    await ui.click('.side .pf-exit .wspick-choose');
    await ui.locator('.wspick-banner').waitFor({ timeout: 10000 });
    const pkOn = await ui.evaluate(() => ({ t: document.querySelector('.wspick-banner')?.innerText ?? '', p: globalThis.wsPicking() }));
    await ui.click('.wspick-cancel');
    const pkOff = await ui.evaluate(() => ({ b: !!document.querySelector('.wspick-banner'), name: document.querySelector('.side .placeform > .pf-row[data-field="name"] input')?.value, p: globalThis.wsPicking() }));
    check('Pick mode: a big "Picking exit destination…" banner with Cancel; the form comes back intact on Cancel',
        /Picking exit destination/.test(pkOn.t) && /Cancel/.test(pkOn.t) && pkOn.p?.kind === 'room' && !pkOff.b && pkOff.name === 'Coal Shed' && pkOff.p === null, JSON.stringify([pkOn, pkOff]));
    await pickSet(ui.locator('.side .pf-exit .wspick'), mwFORGE);
    await ui.fill('.side .pf-exit .pf-dir[data-field="direction"]', 'north');
    const cpSides = await ui.evaluate(() => ({ heads: [...document.querySelectorAll('.side .pf-exit .pf-side-head')].map(h => h.textContent), back: document.querySelector('.side .pf-exit .pf-dir[data-field="back_direction"]')?.value }));
    check('Create place: exit sides read "From Coal Shed, go ___ to reach …" / "From …, go ___ to get back", the way back filled in',
        /^From Coal Shed, go\s*to reach Brask.s Smithy$/.test(cpSides.heads[0] ?? '') && /^From Brask.s Smithy, go\s*to get back$/.test(cpSides.heads[1] ?? '') && cpSides.back === 'south', JSON.stringify(cpSides));
    try { await ui.waitForFunction(() => /Coal Shed/.test(document.querySelector('.side .editlive-diff')?.innerText ?? ''), null, { timeout: 8000 }); } catch {}
    check('Create place: the diff shows the new place before Submit', /Coal Shed/.test(await ui.evaluate(() => document.querySelector('.side .editlive-diff')?.innerText ?? '')));
    await ui.click('.side button.pf-submit');
    try { await ui.waitForFunction(() => document.querySelector('.side .mapaction')?.dataset.action === 'delete_place', null, { timeout: 12000 }); } catch {}
    const mwCp = await mwLastMsg(mwNW);
    const mwBack = await ui.evaluate(() => ({ a: document.querySelector('.side .mapaction')?.dataset.action, casc: !!document.querySelector('.side .mw-cascade'), sub: !!document.querySelector('.side .mw-submit') }));
    check('Add a place first: stamps create_place (with its exit) and returns to the delete, now without the cascade', mwCp.grew && mwCp.sys && mwCp.ops[0]?.op === 'create_place' && mwCp.ops[0]?.exits?.[0]?.to === mwFORGE && mwBack.a === 'delete_place' && !mwBack.casc && mwBack.sub, JSON.stringify([mwCp, mwBack]));
    await ui.click('.side .mw-submit'); await mwSavedWait();
    const mwDp = await mwLastMsg(mwCp.n);
    check('Delete place: stamps remove_location', mwDp.grew && mwDp.ops[0]?.op === 'remove_location' && mwDp.ops[0]?.loc === mwFORGE, JSON.stringify(mwDp));
    await mwCut(mwNW);
    // Move with a clash: the rename box is prefilled with a suggested unique id; never overwritten.
    mwNW = await page.evaluate(() => SillyTavern.getContext().chat.length);
    await mwAct('riverton:drowned_rat/common_room', 'move_place');
    // A real pick: search shows full paths, a result jumps the map there, double-click asks "Choose …?", Yes fills it.
    await ui.click('.side .mw-row[data-field="dest"] .wspick-choose');
    await ui.locator('.wspick-banner').waitFor({ timeout: 10000 });
    await ui.fill('.wspick-search', 'gilded');
    const pkRes = await ui.evaluate(() => [...document.querySelectorAll('.wspick-results li')].map(li => li.textContent));
    await ui.click('.wspick-results li[data-id="riverton:gilded_goose"]');
    const pkMap = await ui.evaluate(() => ({ p: globalThis.wsPicking(), ok: !!document.querySelector('.node.pickable[data-id="sub:riverton:gilded_goose"]'), dim: !!document.querySelector('.node.pickdim[data-id="sub:riverton:drowned_rat"]') }));
    await ui.dispatchEvent('.node[data-id="sub:riverton:gilded_goose"]', 'dblclick');
    const pkQ = await ui.evaluate(() => document.querySelector('.wspick-confirm')?.innerText ?? '');
    await ui.click('.wspick-yes');
    const pkDone = await ui.evaluate(() => ({ b: !!document.querySelector('.wspick-banner'), v: document.querySelector('.side .mw-row[data-field="dest"] .wspick')?.value, shown: document.querySelector('.side .mw-row[data-field="dest"] .wspick-value')?.textContent }));
    check('Pick mode: search results carry full paths; picking one opens its level with valid targets highlighted and the edited one dimmed',
        pkRes.some(t => / › .*Gilded/.test(t)) && pkMap.p?.layer === 'riverton:' && pkMap.ok && pkMap.dim, JSON.stringify([pkRes, pkMap]));
    check('Pick mode: double-click asks "Choose …?", Yes fills the field (full path) and restores the form', /^Choose .*Gilded.*\?/.test(pkQ) && !pkDone.b && pkDone.v === 'riverton:gilded_goose' && / › /.test(pkDone.shown), JSON.stringify([pkQ, pkDone]));
    await ui.locator('.side .mw-rename').waitFor({ timeout: 8000 });
    check('Move place onto a taken id: rename prompt prefilled with a suggested id', (await ui.inputValue('.side .mw-rename')) === 'drowned_rat_common_room');
    await ui.click('.side .mw-submit'); await mwSavedWait();
    const mwMp = await mwLastMsg(mwNW);
    check('Move place: stamps move_location with the new id', mwMp.grew && mwMp.ops[0]?.op === 'move_location' && mwMp.ops[0]?.area === 'riverton:gilded_goose' && mwMp.ops[0]?.id === 'drowned_rat_common_room', JSON.stringify(mwMp));
    await mwCut(mwNW);
    // Delete a subregion, moving its places into another (how two subregions merge), clashes renamed.
    await mwAct('sub:riverton:gilded_goose', 'delete_subregion');
    await ui.selectOption('.side .mw-row[data-field="contents"] select', 'move');
    await pickSet(ui.locator('.side .mw-row[data-field="into"] .wspick'), 'riverton:drowned_rat');
    const mwRen = await ui.evaluate(() => [...document.querySelectorAll('.side .mw-rename')].map(i => i.value));
    check('Delete subregion → move places: every clashing id gets a prefilled rename', JSON.stringify(mwRen) === JSON.stringify(['gilded_goose_common_room', 'gilded_goose_upstairs']), JSON.stringify(mwRen));
    await ui.click('.side .mw-submit'); await mwSavedWait();
    const mwDs = await mwLastMsg(mwNW);
    check('Delete subregion with move: stamps remove_area with into and the renames', mwDs.grew && mwDs.ops[0]?.op === 'remove_area' && mwDs.ops[0]?.contents === 'move' && mwDs.ops[0]?.into === 'riverton:drowned_rat' && mwDs.ops[0]?.ids?.common_room === 'gilded_goose_common_room', JSON.stringify(mwDs));
    await mwCut(mwNW);
    // The starting region can't be deleted.
    await mwAct('region:riverton', 'delete_region');
    check('Delete region: the starting region is refused', /starting region/.test(await ui.evaluate(() => document.querySelector('.side .mw-blocked')?.textContent ?? '')) && await ui.isDisabled('.side .mw-submit'));
    // Create region (world level) with Expand with AI: the prompt holds the exit's neighbor, never the whole world.
    await mwAct('world', 'create_region');
    await ui.fill('.side .mw-row[data-field="region_name"] input', 'Fen Marsh');
    await ui.fill('.side .mw-row[data-field="sub_name"] input', 'Reeds');
    await ui.fill('.side .mw-row[data-field="place_name"] input', 'Reed Hut');
    await ui.click('.side .mw-addexit');
    await pickSet(ui.locator('.side .mw-exit .wspick').first(), 'riverton:east_road/road');
    await ui.fill('.side .mw-row[data-field="place_description"] textarea', 'a hut');
    await queue([{ content: 'A hut on stilts above black water.' }]);
    const mwNReq = (await (await fetch(`${FAKE}/__requests`)).json()).length;
    await ui.click('.side .mapaction .mw-ai >> nth=-1');
    try { await ui.waitForFunction(() => /stilts/.test(document.querySelector('.side .mw-row[data-field="place_description"] textarea')?.value ?? ''), null, { timeout: 20000 }); } catch {}
    const mwReqs = (await (await fetch(`${FAKE}/__requests`)).json()).slice(mwNReq), mwPr = JSON.stringify(mwReqs.at(-1)?.messages ?? []);
    check('Expand with AI: fills the field from the model', /stilts/.test(await ui.inputValue('.side .mw-row[data-field="place_description"] textarea')));
    check('Expand with AI: the prompt has the draft and the exit\'s neighbor, not the whole world', /a hut/.test(mwPr) && /East Road|road/i.test(mwPr) && !/Temple of the Tides|Larkspur/.test(mwPr), mwPr.slice(0, 600));
    await ui.click('.side .mw-submit'); await mwSavedWait();
    const mwCr = await mwLastMsg(mwNW);
    check('Create region: stamps create_region with its first subregion and starting place', mwCr.grew && mwCr.ops[0]?.op === 'create_region' && mwCr.ops[0]?.subregion?.name === 'Reeds' && mwCr.ops[0]?.subregion?.place?.exits?.[0]?.to === 'riverton:east_road/road', JSON.stringify(mwCr));
    await mwCut(mwNW);
    // ---- Turning past changes off and on again: dependents confirm, can't-apply notes, hidden notes, inspector toggle.
    const BURNT = 'riverton:drowned_rat/burnt_inn', YARD = 'riverton:drowned_rat/courtyard';
    const nTog = await page.evaluate(() => SillyTavern.getContext().chat.length);
    const stamped = await page.evaluate(async ([mod, CR, YARD, BURNT]) => {
        const m = await import(mod);
        const a = await m.liveEdit([{ op: 'merge', locs: [CR, YARD], id: 'burnt_inn', name: 'Burnt Inn', description: 'Ash and beams.' }], 'fire', { separate: true });
        const b = await m.liveEdit([{ op: 'set_description', loc: BURNT, text: 'Soot everywhere.' }], 'soot', { separate: true }); // its own message: this block toggles across messages
        m.renderPatchCards(); return [a, b];
    }, [wsMod, CR, YARD, BURNT]);
    check('toggle setup: two stamped changes, the second built on the first', stamped.every(r => r.ok) && stamped[0].msg === nTog && stamped[1].msg === nTog + 1, JSON.stringify(stamped));
    const tA = nTog, tB = nTog + 1;
    const cardA = page.locator(`#chat .mes[mesid="${tA}"] .worldscrawl_patchcard`), cardB = page.locator(`#chat .mes[mesid="${tB}"] .worldscrawl_patchcard`);
    for (const k of [tA, tB]) { const d = page.locator(`#chat .mes[mesid="${k}"] details.worldscrawl_carrier`); await d.waitFor({ timeout: 10000 }); if (!(await d.evaluate(e => e.open))) await d.locator('summary').first().click(); } // carriers start collapsed
    await cardA.locator('.worldscrawl_card_btn', { hasText: 'Turn off' }).waitFor({ timeout: 10000 });
    check('kept change cards have a Turn off button', await cardB.locator('.worldscrawl_card_btn', { hasText: 'Turn off' }).count() === 1);
    await cardA.locator('.worldscrawl_card_btn', { hasText: 'Turn off' }).click();
    const conf = page.locator('.worldscrawl_confirm');
    await conf.waitFor({ timeout: 10000 });
    const confText = await conf.innerText();
    check('turning off asks first, listing the later change that needs it', confText.includes(`#${tB}`) && /Turn off all/.test(confText) && /Just this one/.test(confText) && /Cancel/.test(confText), confText);
    await conf.locator('.worldscrawl_card_btn', { hasText: 'Cancel' }).click(); await page.waitForTimeout(500);
    check('Cancel leaves it on, no note', await page.evaluate(([a, n]) => { const c = SillyTavern.getContext(); return !c.chat[a].extra.worldscrawl_patches[0].off && c.chat.length === n; }, [tA, tB + 1]));
    await cardA.locator('.worldscrawl_card_btn', { hasText: 'Turn off' }).click();
    await conf.waitFor({ timeout: 10000 });
    await conf.locator('.worldscrawl_card_btn', { hasText: 'Just this one' }).click(); await page.waitForTimeout(1500);
    const off1 = await page.evaluate(([a, b]) => { const c = SillyTavern.getContext(), m = c.chat[c.chat.length - 1]; return { a: c.chat[a].extra.worldscrawl_patches[0].off, b: c.chat[b].extra.worldscrawl_patches[0].off ?? false, kept: c.chat[a].extra.worldscrawl_patches[0].ops.length, mes: m.mes, sys: m.is_system, notice: m.extra?.worldscrawl_notice }; }, [tA, tB]);
    check('Just this one: only it is turned off, still stored on its message', off1.a === true && off1.b === false && off1.kept === 1, JSON.stringify(off1));
    check('a hidden note says what was turned off', off1.mes === `Map edit: turned off the change from #${tA}` && off1.sys === true && off1.notice === true, JSON.stringify(off1));
    try { await cardB.locator('.worldscrawl_inactive').waitFor({ timeout: 10000 }); } catch {}
    check('the later change that needed it shows a greyed Inactive note naming why', (await cardB.innerText()).includes(`Inactive: depends on message #${tA}, which is turned off`), await cardB.innerText());
    check('the inactive card hides Turn off and keeps Undo', await cardB.locator('.worldscrawl_card_btn', { hasText: 'Turn off' }).count() === 0 && await cardB.locator('.worldscrawl_card_btn', { hasText: 'Undo' }).count() === 1, await cardB.innerText());
    check('turned-off card offers Turn on', await cardA.locator('.worldscrawl_card_btn', { hasText: 'Turn on' }).count() === 1);
    const mapCtxNow = await page.evaluate(async mod => { const m = await import(mod); return { changes: m.chatChanges(), now: m.chatElapsed(), world: SillyTavern.getContext().extensionSettings.worldscrawl.world || '' }; }, wsMod);
    const mapRes = await stFetch(`/rooms${mapCtxNow.world ? `?world=${encodeURIComponent(mapCtxNow.world)}` : ''}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ addresses: [CR], changes: mapCtxNow.changes, now: mapCtxNow.now }) });
    const mapOk = [mapRes.status, mapRes.ok ? (await mapRes.json()).rooms?.length : mapRes.text];
    check('the map still works with the change off (the merged room is back)', mapOk[0] === 200 && mapOk[1] === 1, JSON.stringify(mapOk));
    await cardA.locator('.worldscrawl_card_btn', { hasText: 'Turn on' }).click(); await page.waitForTimeout(1500);
    try { await page.waitForFunction(b => !document.querySelector(`#chat .mes[mesid="${b}"] .worldscrawl_cant_apply`), tB, { timeout: 10000 }); } catch {}
    const on1 = await page.evaluate(a => { const c = SillyTavern.getContext(); return { off: c.chat[a].extra.worldscrawl_patches[0].off, mes: c.chat[c.chat.length - 1].mes }; }, tA);
    check('Turn on puts it back (with its own hidden note) and the red note goes', on1.off === undefined && on1.mes === `Map edit: turned on the change from #${tA}` && await cardB.locator('.worldscrawl_cant_apply').count() === 0, JSON.stringify(on1));
    // The same toggle in the map window's inspector, Changes tab.
    let tabOk = false;
    for (let k = 0; k < 5 && !tabOk; k++) {
        await ui.click(`.node[data-id="${BURNT}"]`).catch(() => {}); await ui.waitForTimeout(1200);
        await ui.click('.side .tabs button:has-text("Changes")').catch(() => {}); await ui.waitForTimeout(500);
        tabOk = await ui.locator(`.side li.change:has-text("Message #${tA}") .togglechange`).count() === 1;
    }
    check('inspector Changes tab has a Turn off button per change', tabOk);
    await ui.click(`.side li.change:has-text("Message #${tA}") .togglechange`);
    const uconf = ui.locator('.toggle-confirm');
    try { await uconf.waitFor({ timeout: 10000 }); } catch {}
    check('inspector asks first too, listing the dependent', (await uconf.count()) === 1 && (await uconf.innerText()).includes(`#${tB}`));
    await uconf.locator('button:has-text("Turn off all")').click(); await page.waitForTimeout(2000);
    const off2 = await page.evaluate(([a, b]) => { const c = SillyTavern.getContext(); return { a: c.chat[a].extra.worldscrawl_patches[0].off, b: c.chat[b].extra.worldscrawl_patches[0].off, mes: c.chat[c.chat.length - 1].mes }; }, [tA, tB]);
    check('inspector Turn off all: both off, one hidden note naming both', off2.a === true && off2.b === true && off2.mes === `Map edit: turned off the change from #${tA} (and the changes from #${tB})`, JSON.stringify(off2));
    try { await ui.waitForSelector(`.node[data-id="${CR}"]`, { timeout: 10000 }); } catch {}
    check('map shows the original rooms again', await ui.locator(`.node[data-id="${CR}"]`).count() === 1 && await ui.locator(`.node[data-id="${BURNT}"]`).count() === 0);
    await page.evaluate(n => SillyTavern.getContext().executeSlashCommandsWithOptions(`/cut ${n}-${SillyTavern.getContext().chat.length - 1}`), tA); await page.waitForTimeout(1500);
    // ---- Discovery rooms: a door the description only mentions is opened; the room behind it is added at once.
    const UPST = 'riverton:drowned_rat/upstairs';
    const roomsNow = async addrs => { const x = await page.evaluate(async mod => { const m = await import(mod); return { changes: m.chatChanges(), now: m.chatElapsed(), world: SillyTavern.getContext().extensionSettings.worldscrawl.world || '' }; }, wsMod);
        const r = await stFetch(`/rooms${x.world ? `?world=${encodeURIComponent(x.world)}` : ''}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ addresses: addrs, changes: x.changes, now: x.now }) }); return r.ok ? (await r.json()).rooms : r.text; };
    const upDesc0 = (await roomsNow([UPST]))?.[0]?.description;
    const ROOMJ = JSON.stringify({ name: 'End Guest Room', description: 'A low room with a narrow bed and a washstand under the eaves.', direction: 'end guest room', return_direction: 'hallway', exit_description: 'A plain door at the end of the hall.', return_description: 'The door back to the hallway.' });
    await queue([{ content: ROOMJ }]);
    const nDisc = await page.evaluate(async ([mod, UPST]) => {
        const m = await import(mod), c = SillyTavern.getContext();
        c.chat.push({ name: 'User', is_user: true, mes: 'I try the door at the end of the hall.', extra: { worldscrawl_location: UPST, worldscrawl_intent_checked: true } },
            { name: 'Narrator', is_user: false, mes: 'The door creaks open. [ws_flag: discover | the door at the end of the hall]', extra: {} });
        await c.saveChat();
        const id = c.chat.length - 1; await m.onReplyForFlags(id); return id;
    }, [wsMod, UPST]);
    try { await page.waitForFunction(id => SillyTavern.getContext().chat[id]?.extra?.worldscrawl_patches?.length, nDisc, { timeout: 20000 }); } catch {}
    const disc = await page.evaluate(id => { const m = SillyTavern.getContext().chat[id]; return { mes: m.mes, f: m.extra.worldscrawl_flag, p: m.extra.worldscrawl_patches?.[0] }; }, nDisc);
    const DROOM = 'riverton:drowned_rat/end_guest_room';
    check('discovery: the [ws_flag: discover] tag is stripped and the room is stamped at once (no review card)', !/ws_flag/.test(disc.mes) && disc.f?.status === 'kept' && disc.p?.ops?.[0]?.op === 'create_place' && disc.p.ops[0].id === 'end_guest_room', JSON.stringify(disc));
    const discCard = page.locator(`#chat .mes[mesid="${nDisc}"] .worldscrawl_patchcard`);
    check('discovery: no Keep / Discard buttons', await discCard.locator('.worldscrawl_card_btn', { hasText: 'Discard' }).count() === 0);
    const dReqs = await (await fetch(`${FAKE}/__requests`)).json();
    const dPrompt = JSON.stringify(dReqs[dReqs.length - 1]);
    check('discovery: the model sees the room, its neighbours and the area notes', /Upstairs Rooms/.test(dPrompt) && /Common Room/.test(dPrompt) && /Area: /.test(dPrompt), dPrompt.slice(0, 300));
    const after = await roomsNow([UPST, DROOM]);
    check('discovery: the new room exists, the hallway text is untouched', after?.length === 2 && after.some(r => r.name === 'End Guest Room') && after.find(r => r.address === UPST || r.name === 'Upstairs Rooms')?.description === upDesc0, JSON.stringify(after));
    // Standing in the discovered room, then turning the discovery off: the party is moved back to the hallway.
    const offDisc = await page.evaluate(async ([mod, id, DROOM]) => {
        const m = await import(mod), c = SillyTavern.getContext();
        c.chat.push({ name: 'User', is_user: true, mes: 'I step inside.', extra: { worldscrawl_location: DROOM, worldscrawl_intent_checked: true } }); await c.saveChat();
        const pid = c.chat[id].extra.worldscrawl_patches[0].id;
        const r = await m.toggleChange(id, pid, { choice: 'one' });
        const st = await m.mapState();
        return { r, loc: st.location, off: c.chat[id].extra.worldscrawl_patches[0].off };
    }, [wsMod, nDisc, DROOM]);
    check('discovery: turning it off while standing in it moves the party to the hallway', offDisc.off === true && offDisc.loc === UPST, JSON.stringify(offDisc));
    await page.evaluate(async n => { const c = SillyTavern.getContext(); c.chat.splice(n - 1); await c.saveChat(); await c.reloadCurrentChat(); }, nDisc); await page.waitForTimeout(1500);
    // Flagging the player's own message checks the narrator's reply right after it (from the player's message on).
    await queue([{ content: '{"rooms": [], "areas": []}' }]);
    const uf = await page.evaluate(async ([mod, UPST]) => {
        const m = await import(mod), c = SillyTavern.getContext();
        c.chat.push({ name: 'User', is_user: true, mes: 'I kick the wall.', extra: { worldscrawl_location: UPST, worldscrawl_intent_checked: true } });
        c.chat.push({ name: 'Narrator', is_user: false, mes: 'The plaster cracks.', extra: { worldscrawl_location: UPST } }); await c.saveChat();
        const u = c.chat.length - 2, n = u + 1; const t = await m.flagMessage(u);
        for (let k = 0; k < 40 && c.chat[n].extra.worldscrawl_flag?.status === 'working'; k++) await new Promise(r => setTimeout(r, 250));
        return { u, t, userFlag: !!c.chat[u].extra.worldscrawl_flag, reply: c.chat[n].extra.worldscrawl_flag };
    }, [wsMod, UPST]);
    check('flagging the player\'s message flags the narrator reply after it, from the player\'s message on', !uf.userFlag && uf.reply?.start === uf.u && uf.reply?.status === 'nothing', JSON.stringify(uf));
    await page.evaluate(async n => { const c = SillyTavern.getContext(); c.chat.splice(n); await c.saveChat(); await c.reloadCurrentChat(); }, uf.u); await page.waitForTimeout(1500);
    // The change call: "can't express this" is shown plainly; three new rooms off a hub come back as one reviewable change.
    const changeFlag = async (answers) => { await queue(answers); return page.evaluate(async ([mod, UPST]) => {
        const m = await import(mod), c = SillyTavern.getContext();
        c.chat.push({ name: 'Narrator', is_user: false, mes: 'Magic reshapes the hallway.', extra: { worldscrawl_location: UPST } }); await c.saveChat();
        const id = c.chat.length - 1; await m.flagMessage(id, { note: 'magic', source: 'button' });
        for (let k = 0; k < 40 && c.chat[id].extra.worldscrawl_flag?.status === 'working'; k++) await new Promise(r => setTimeout(r, 250));
        const f = c.chat[id].extra.worldscrawl_flag;
        await c.reloadCurrentChat(); await new Promise(r => setTimeout(r, 1500)); m.renderPatchCards();
        const card = document.querySelector(`.mes[mesid="${id}"] .worldscrawl_patchcard`)?.textContent ?? '';
        return { id, status: f?.status, error: f?.error, ops: f?.proposal?.ops, summary: f?.proposal?.summary, card };
    }, [wsMod, UPST]); };
    const cant = await changeFlag([{ content: JSON.stringify({ rooms: [UPST] }) }, { content: JSON.stringify({ cant: 'The hallway now floats above the town.' }) }]);
    check("change call: a \"can't express this\" answer is shown plainly, no forced edit", cant.status === 'cant' && /floats above the town/.test(cant.error) && !cant.ops && /Can't show this on the map: The hallway now floats/.test(cant.card) && /Retry/.test(cant.card), JSON.stringify(cant));
    await page.evaluate(async n => { const c = SillyTavern.getContext(); c.chat.splice(n); await c.saveChat(); await c.reloadCurrentChat(); }, cant.id); await page.waitForTimeout(1500);
    // A manual flag never ends silently: an empty {"ops": []} reply, an unreadable answer, a model error.
    const empty = await changeFlag([{ content: JSON.stringify({ rooms: [UPST] }) }, { content: JSON.stringify({ ops: [] }) }]);
    check('manual flag: an empty {"ops": []} reply shows "no map change found" with Retry', empty.status === 'nothing' && /No map change found/.test(empty.card) && /Retry/.test(empty.card), JSON.stringify(empty));
    await page.evaluate(async n => { const c = SillyTavern.getContext(); c.chat.splice(n); await c.saveChat(); await c.reloadCurrentChat(); }, empty.id); await page.waitForTimeout(1500);
    const junk = await changeFlag([{ content: 'I cannot help with portals.' }]);
    check('manual flag: an unreadable answer shows an error in the bar with Retry', junk.status === 'error' && /Map change failed: .*not JSON/.test(junk.card) && /Retry/.test(junk.card), JSON.stringify(junk));
    await page.evaluate(async n => { const c = SillyTavern.getContext(); c.chat.splice(n); await c.saveChat(); await c.reloadCurrentChat(); }, junk.id); await page.waitForTimeout(1500);
    await queue([]);
    const dbg = await page.evaluate(async ([mod, UPST]) => {
        const m = await import(mod), c = SillyTavern.getContext(), seen = [], orig = console.info;
        m.settings().showEditMessages = true; console.info = (...a) => { seen.push(String(a[0])); orig(...a); };
        const gen = c.generateRaw; let threw = false;
        c.chat.push({ name: 'Narrator', is_user: false, mes: 'A portal to a mind dimension opens for exactly 1 hour.', extra: { worldscrawl_location: UPST } }); await c.saveChat();
        const id = c.chat.length - 1;
        try {
            const t = await m.flagMessage(id, { source: 'button' });
            for (let k = 0; k < 40 && c.chat[id].extra.worldscrawl_flag?.status === 'working'; k++) await new Promise(r => setTimeout(r, 250));
        } catch { threw = true; }
        console.info = orig; m.settings().showEditMessages = false;
        const f = c.chat[id].extra.worldscrawl_flag;
        return { id, threw, status: f?.status, seen };
    }, [wsMod, UPST]);
    await page.evaluate(() => SillyTavern.getContext().reloadCurrentChat()); await page.waitForTimeout(2000); // the pushed message gets its block
    dbg.card = await page.evaluate(id => document.querySelector(`.mes[mesid="${id}"] .worldscrawl_patchcard`)?.textContent ?? '', dbg.id);
    check('manual flag: with the fake model out of answers it still ends visibly, and Debug logs the call', !dbg.threw && dbg.status !== 'working' && /🗺/.test(dbg.card) && /Retry|Approve/.test(dbg.card) && dbg.seen.some(x => /map edit call/.test(x)), JSON.stringify(dbg));
    await page.evaluate(async n => { const c = SillyTavern.getContext(); c.chat.splice(n); await c.saveChat(); await c.reloadCurrentChat(); }, dbg.id); await page.waitForTimeout(1500);
    const mk = (n, d) => ({ op: 'create_place', id: 'bogus', name: n, description: `A ${n.toLowerCase()} made by magic.`, exits: [{ to: UPST, direction: 'hallway', return_direction: d }] });
    const hubR = await changeFlag([{ content: JSON.stringify({ rooms: [UPST] }) }, { content: JSON.stringify({ ops: [mk('Crystal Room', 'crystal arch'), mk('Ember Room', 'ember arch'), mk('Tide Room', 'tide arch')] }) }]);
    check('change call: three new rooms off a hub in one change, engine-made ids', hubR.status === 'review' && hubR.ops?.length === 3 && hubR.ops.every(o => o.op === 'create_place' && o.id !== 'bogus' && o.story === true)
        && JSON.stringify(hubR.ops.map(o => o.id)) === JSON.stringify(['crystal_room', 'ember_room', 'tide_room']), JSON.stringify(hubR).slice(0, 600));
    await page.evaluate(async n => { const c = SillyTavern.getContext(); c.chat.splice(n); await c.saveChat(); await c.reloadCurrentChat(); }, hubR.id); await page.waitForTimeout(1500);
    // Duplicate-room guard: a "new" Courtyard two steps away is connected to the existing one; the card offers to make it a new room instead.
    const dupR = await changeFlag([{ content: JSON.stringify({ rooms: [UPST] }) }, { content: JSON.stringify({ ops: [mk('Courtyard', 'side stair')] }) }]);
    check('duplicate guard: the new Courtyard becomes a door to the existing one, with a Make it a new room instead button', dupR.status === 'review' && dupR.ops?.every(o => o.op === 'add_exit') && /Connected to/.test(dupR.card) && /Make it a new room instead/.test(dupR.card), JSON.stringify(dupR).slice(0, 600));
    const unm = await page.evaluate(async ([mod, id]) => {
        const b = [...document.querySelectorAll(`.mes[mesid="${id}"] .worldscrawl_patchcard .worldscrawl_card_btn`)].find(x => /Make it a new room instead/.test(x.textContent)); if (!b) return null;
        b.click(); await new Promise(r => setTimeout(r, 1500));
        const p = SillyTavern.getContext().chat[id].extra.worldscrawl_flag?.proposal; return { ops: p?.ops, summary: p?.summary, unmerged: !!p?.unmerged };
    }, [wsMod, dupR.id]);
    check('Make it a new room instead: the proposal becomes a create_place for a new room', unm?.ops?.length === 1 && unm.ops[0].op === 'create_place' && unm.ops[0].name === 'Courtyard' && !unm.unmerged && unm.summary?.some(x => /Added as a new room/.test(x)), JSON.stringify(unm));
    await page.evaluate(async n => { const c = SillyTavern.getContext(); c.chat.splice(n); await c.saveChat(); await c.reloadCurrentChat(); }, dupR.id); await page.waitForTimeout(1500);
    // A door no description mentions: "I open a door down the hall" in the upstairs hallway. The intent check offers
    // "try another door", the narrator is told to open it only if it fits, and its flag adds the room.
    const mode0 = await page.evaluate(async ([mod, UPST]) => {
        const m = await import(mod), c = SillyTavern.getContext(), was = m.settings().moveMode; m.settings().moveMode = 'typed';
        c.chat.push({ name: 'User', is_user: true, mes: 'I head up to the hallway.', extra: { worldscrawl_location: UPST, worldscrawl_intent_checked: true } });
        c.chat.push({ name: 'Narrator', is_user: false, mes: 'You stand in the upstairs hallway.', extra: { worldscrawl_location: UPST } });
        await c.saveChat(); await c.reloadCurrentChat(); return { was, n: c.chat.length };
    }, [wsMod, UPST]);
    await page.waitForTimeout(1500);
    expected = (await reqsNow()).length; rL = expected;
    await queue([{ content: 'try another door' }, { content: 'Halfway down the hall a plain door gives under your hand. [ws_flag: discover | a door down the hall]' }, { content: ROOMJ }]);
    await send('I open a door down the hall', 3);
    for (let k = 0; k < 40; k++) { const st = await page.evaluate(() => SillyTavern.getContext().chat.at(-1)?.extra?.worldscrawl_flag?.status); if (st && st !== 'working') break; await page.waitForTimeout(250); }
    lq = (await reqsNow()).slice(rL); lk = await lastU();
    check('undescribed door: the intent check offers "try another door"', lq.length >= 1 && promptOf(lq[0]).includes('try another door: the player opens or tries a door'), promptOf(lq[0] ?? {}).slice(-600));
    check('undescribed door: the message is marked and the narrator is told to open it only if it fits', lk.extra.worldscrawl_new_door === true && promptOf(lq[1] ?? {}).includes('tries a door that is not among the exits') && promptOf(lq[1] ?? {}).includes('If no such door fits'), promptOf(lq[1] ?? {}).slice(-700));
    const nd = await page.evaluate(() => { const m = SillyTavern.getContext().chat.at(-1); return { mes: m.mes, f: m.extra?.worldscrawl_flag, p: m.extra?.worldscrawl_patches?.[0] }; });
    check('undescribed door: the flag adds the room behind it at once', nd.f?.kind === 'discover' && nd.f?.status === 'kept' && nd.p?.ops?.[0]?.op === 'create_place' && !/ws_flag/.test(nd.mes), JSON.stringify(nd).slice(0, 600));
    check('undescribed door: the discovery prompt allows a door the description does not mention', promptOf(lq[2] ?? {}).includes('does not mention but that plausibly fits'), promptOf(lq[2] ?? {}).slice(0, 400));
    await page.evaluate(async ([mod, n, was]) => { const m = await import(mod), c = SillyTavern.getContext(); m.settings().moveMode = was; c.chat.splice(n - 2); await c.saveChat(); await c.reloadCurrentChat(); }, [wsMod, mode0.n, mode0.was]);
    await page.waitForTimeout(1500);
    // Bulk move: places stood in before Larkspur moves into Riverton stay on the map at their new addresses (stamped
    // locations go through the move's redirects), without visiting any of them first.
    const bmN = await page.evaluate(async () => { const c = SillyTavern.getContext(); const m = c.chat[1] ?? c.chat[0];
        m.extra = { ...(m.extra ?? {}), worldscrawl_move: { ...(m.extra?.worldscrawl_move ?? {}), via: [...(m.extra?.worldscrawl_move?.via ?? []), 'larkspur:west_road/road', 'larkspur:green/green', 'larkspur:playhouse/foyer'] } };
        await c.saveChat(); return c.chat.length; });
    await mwAct('region:larkspur', 'delete_region');
    await ui.selectOption('.side .mw-row[data-field="contents"] select', 'move');
    await pickSet(ui.locator('.side .mw-row[data-field="into"] .wspick'), 'riverton');
    await ui.locator('.side .wsdiff-move-group').first().waitFor({ timeout: 10000 }).catch(() => {});
    const bmDiff = await ui.evaluate(() => { const g = [...document.querySelectorAll('.side .wsdiff-move-group')]; return { groups: g.length, head: g[0]?.querySelector('.wsdiff-move-head')?.textContent, subs: [...(g[0]?.querySelectorAll(':scope > .wsdiff-move[data-kind="subregion"]') ?? [])].map(x => x.dataset.old), details: g[0]?.querySelectorAll('details').length ?? 0, note: g[0]?.querySelector(':scope > .wsdiff-note')?.textContent ?? '', places: document.querySelectorAll('.side .wsdiff-place').length }; });
    check('bulk move diff: one group "Larkspur → into Riverton", one collapsible line per subregion, one inheritance note, no per-field place dump', bmDiff.groups === 1 && /Larkspur → into Riverton/.test(bmDiff.head) && bmDiff.subs.length === 7 && bmDiff.details === 7 && /^now inherits Riverton's .* instead of Larkspur's$/.test(bmDiff.note) && bmDiff.places === 0, JSON.stringify(bmDiff));
    await ui.click('.side .mw-submit'); await mwSavedWait();
    await ui.click('#editorToggle'); await ui.waitForTimeout(1500);
    await ui.click('#breadcrumb .crumb[data-level="world"]').catch(() => {}); await ui.waitForTimeout(300);
    await ui.dblclick('.node[data-id="region:riverton"]').catch(() => {}); await ui.waitForTimeout(500);
    const bmIds = await nodeIds();
    check('bulk move: the destination region map shows every moved subregion that was stood in, without visiting them', ['west_road', 'green', 'playhouse'].every(s => bmIds.includes(`sub:riverton:${s}`)) && !bmIds.some(i => i.includes('larkspur')), JSON.stringify(bmIds));
    await ui.click('#editorToggle'); await ui.waitForTimeout(300);
    // The Changes tab lists the move the same way (one group, a line per subregion).
    await ui.evaluate(() => globalThis.wsInspect('world')); await ui.waitForTimeout(1200);
    await ui.click('.side .tabs button:has-text("Changes")').catch(() => {}); await ui.waitForTimeout(500);
    const bmHist = await ui.evaluate(() => ({ groups: document.querySelectorAll('.side .wsdiff-move-group').length, subs: document.querySelectorAll('.side .wsdiff-move-group .wsdiff-move[data-kind="subregion"]').length, note: document.querySelector('.side .wsdiff-move-group .wsdiff-note')?.textContent ?? '' }));
    check('Changes tab: the bulk move is one group with a line per subregion and the inheritance note', bmHist.groups >= 1 && bmHist.subs === 7 && /now inherits Riverton's/.test(bmHist.note), JSON.stringify(bmHist));
    await mwCut(bmN);
    await page.evaluate(async () => { const c = SillyTavern.getContext(), m = c.chat[1] ?? c.chat[0]; m.extra.worldscrawl_move.via = m.extra.worldscrawl_move.via.filter(a => !a.startsWith('larkspur:')); await c.saveChat(); });
    await ui.click('#editorToggle'); await ui.waitForTimeout(300);
    // Carriers: consecutive editor edits condense into one visible compact message; one change can be undone or turned off alone;
    // a bulk delete that sweeps the carrier up warns and can put it back.
    const cr = await page.evaluate(async () => {
        const c = SillyTavern.getContext(), m = await import('/scripts/extensions/third-party/WorldScrawl/index.js'), R = 'riverton:drowned_rat/common_room';
        const n0 = c.chat.length, w = c.extensionSettings.worldscrawl.world || '';
        const descNow = async () => (await (await fetch(`/api/plugins/worldscrawl/rooms${w ? `?world=${encodeURIComponent(w)}` : ''}`, { method: 'POST', headers: c.getRequestHeaders(), body: JSON.stringify({ addresses: [R], changes: m.chatChanges(), now: m.chatElapsed() }) })).json()).rooms?.[0]?.description; // the chat's patched map
        const a = await globalThis.worldscrawlLiveEdit([{ op: 'set_description', loc: R, text: 'Carrier one.' }], '', { separate: true });
        const b = await globalThis.worldscrawlLiveEdit([{ op: 'set_description', loc: R, text: 'Carrier two.' }]);
        const d3 = await globalThis.worldscrawlLiveEdit([{ op: 'set_description', loc: 'riverton:drowned_rat/stable', text: 'Carrier three.' }]);
        await new Promise(r => setTimeout(r, 1200));
        const msg = c.chat[c.chat.length - 1], ids = (msg.extra?.worldscrawl_patches ?? []).map(p => p.id);
        const el = document.querySelector(`#chat .mes[mesid="${c.chat.length - 1}"]`);
        const out = { ok: [a.ok, b.ok, d3.ok], added: c.chat.length - n0, n: ids.length, unique: new Set(ids).size, mes: msg.mes, hidden: !!msg.extra?.isSmallSys && false,
            visible: !!el && getComputedStyle(el).display !== 'none', compact: el?.classList.contains('worldscrawl_carrier_mes'), collapsed: el?.querySelector('details.worldscrawl_carrier')?.open === false,
            summary: el?.querySelector('details.worldscrawl_carrier > summary')?.textContent ?? '', undoBtns: el?.querySelectorAll('details.worldscrawl_carrier .menu_button, details.worldscrawl_carrier button').length ?? 0 };
        const mi = c.chat.length - 1;
        const t = await m.toggleChange(mi, ids[2], { choice: 'one' });
        out.offOne = t.ok && c.chat[mi].extra.worldscrawl_patches.filter(p => p.off).length === 1;
        await m.toggleChange(mi, ids[2]); // back on (toggle posts a notice, which ends the run)
        const u = await m.removeChange(mi, ids[1], { choice: 'one' });
        out.undoOne = u.ok && c.chat[mi].extra.worldscrawl_patches.map(p => p.id).join() === [ids[0], ids[2]].join() && /\(2 changes\)/.test(c.chat[mi].mes);
        out.desc = await descNow();
        // A new edit after the toggle notice starts a new carrier.
        const n1 = c.chat.length; await globalThis.worldscrawlLiveEdit([{ op: 'set_description', loc: R, text: 'Carrier four.' }]); out.newRun = c.chat.length === n1 + 1;
        // Bulk delete from the first carrier: the warning remembers both carriers; restore puts them back with the same ids.
        await c.executeSlashCommandsWithOptions(`/cut ${mi}-${c.chat.length - 1}`); await new Promise(r => setTimeout(r, 1500));
        out.lost = globalThis.worldscrawlLostCarriers();
        out.toast = [...document.querySelectorAll('#toast-container .toast')].some(x => /map edits were deleted/.test(x.textContent));
        const n2 = c.chat.length; await globalThis.worldscrawlRestoreCarriers();
        const back = c.chat.slice(n2).flatMap(x => (x.extra?.worldscrawl_patches ?? []).map(p => p.id));
        out.restored = back.includes(ids[0]) && back.includes(ids[2]) && !back.includes(ids[1]);
        out.descBack = await descNow();
        await c.executeSlashCommandsWithOptions(`/cut ${n2}-${c.chat.length - 1}`); await new Promise(r => setTimeout(r, 1000));
        out.cutStart = n0; return out;
    });
    check('carriers: three consecutive edits share one message with three patches (own ids)', cr.ok.every(Boolean) && cr.added === 1 && cr.n === 3 && cr.unique === 3 && /Map update \(3 changes\)/.test(cr.mes), JSON.stringify(cr));
    check('carriers: the message is visible, compact and collapsed, expandable with per-change buttons', cr.visible && cr.compact && cr.collapsed && /Map update \(3 changes\)/.test(cr.summary) && cr.undoBtns >= 9, JSON.stringify(cr));
    check('carriers: turning off one change inside the carrier leaves the others on', cr.offOne, JSON.stringify(cr));
    check('carriers: undoing one change removes only it; the replay applies the rest in order', cr.undoOne && cr.desc === 'Carrier one.', JSON.stringify(cr));
    check('carriers: a message in between starts a new carrier', cr.newRun, JSON.stringify(cr));
    check('bulk delete: carriers swept up are reported with an Undo toast and restored with the same stamps', cr.lost === 2 && cr.toast && cr.restored && cr.descBack === 'Carrier four.', JSON.stringify(cr));
    // Bulk-move Larkspur into Riverton, walk to the Green (stamped at its new Riverton address), turn the move off:
    // the party goes back to the Green in Larkspur (reverse redirect), and the map follows without a new chat message.
    const hereOnMap = () => ui.evaluate(() => document.querySelector('.node.here')?.dataset.id ?? null);
    const waitHere = async want => { for (let k = 0; k < 20 && (await hereOnMap()) !== want; k++) await ui.waitForTimeout(250); return hereOnMap(); };
    const rv0 = await page.evaluate(async () => {
        const c = SillyTavern.getContext(), n0 = c.chat.length;
        const e = await globalThis.worldscrawlLiveEdit([{ op: 'remove_area', area: 'larkspur', contents: 'move', into: 'riverton' }], '', { separate: true });
        const mi = c.chat.length - 1, p = c.chat[mi].extra.worldscrawl_patches.at(-1), to = p.relocate?.['larkspur:green/green'];
        const walk = { name: 'User', is_user: true, send_date: Date.now(), mes: 'I walk to the green.', extra: { worldscrawl_location: to, worldscrawl_move: { from: null, to, via: [to] } } };
        c.chat.push(walk); c.addOneMessage(walk); await c.saveChat();
        await (await import('/scripts/extensions/third-party/WorldScrawl/index.js')).broadcastMapState();
        return { ok: e.ok, n0, mi, pid: p.id, to };
    });
    const rvOnMap = await waitHere(rv0.to);
    const rv = await page.evaluate(async ({ mi, pid }) => {
        const m = await import('/scripts/extensions/third-party/WorldScrawl/index.js'), c = SillyTavern.getContext(), n = c.chat.length;
        const t = await m.toggleChange(mi, pid, { choice: 'one' });
        await new Promise(r => setTimeout(r, 1500));
        return { ok: t.ok, stored: m.getStoredLocation(), userMsgs: c.chat.slice(n).filter(x => x.is_user).length };
    }, rv0);
    const rvOffMap = await waitHere('larkspur:green/green');
    check('reverse redirect: with the bulk move turned off, the party at the moved Green goes back to the Green in Larkspur', rv0.ok && rv0.to === 'riverton:green/green' && rv.ok && rv.stored === 'larkspur:green/green', JSON.stringify([rv0, rv]));
    check('map refresh: the map follows a toggle (no new chat message needed)', rvOnMap === rv0.to && rvOffMap === 'larkspur:green/green' && rv.userMsgs === 0, JSON.stringify([rvOnMap, rvOffMap]));
    await page.evaluate(async ({ mi, pid }) => { await (await import('/scripts/extensions/third-party/WorldScrawl/index.js')).toggleChange(mi, pid); }, rv0);
    const rvOnAgain = await waitHere('riverton:green/green');
    check('map refresh: turning the move on again moves the party (and the map) to the Green in Riverton', rvOnAgain === 'riverton:green/green', String(rvOnAgain));
    // Off → walk to the Green at its Larkspur address → on: the forward redirect applies to a position stamped while the move was off.
    const owo = await page.evaluate(async ({ mi, pid }) => {
        const m = await import('/scripts/extensions/third-party/WorldScrawl/index.js'), c = SillyTavern.getContext(), wait = () => new Promise(r => setTimeout(r, 1500));
        const s0 = m.getStoredLocation();
        await m.toggleChange(mi, pid, { choice: 'one' }); await wait(); const off = m.getStoredLocation();
        const to = 'larkspur:green/green', walk = { name: 'User', is_user: true, send_date: Date.now(), mes: 'I walk to the green.', extra: { worldscrawl_location: to, worldscrawl_move: { from: off, to, via: [to] } } };
        c.chat.push(walk); c.addOneMessage(walk); await c.saveChat();
        await m.toggleChange(mi, pid); await wait();
        return { s0, off, on: m.getStoredLocation() };
    }, rv0);
    const owoMap = await waitHere('riverton:green/green');
    check('round trip on → walk → off → on keeps the party on the Green (never relocated by a toggle)', owo.s0 === 'riverton:green/green' && owo.off === 'larkspur:green/green', JSON.stringify(owo));
    check('off → walk to the Green → on: the move redirects the party forward to the Green in Riverton (map follows)', owo.on === 'riverton:green/green' && owoMap === 'riverton:green/green', JSON.stringify([owo, owoMap]));
    await page.evaluate(async n0 => { const c = SillyTavern.getContext(); await c.executeSlashCommandsWithOptions(`/cut ${n0}-${c.chat.length - 1}`); }, rv0.n0); await page.waitForTimeout(1500);
    // /ws-reveal: stamps places as been-there (map + /ws-known + /ws-go use it); "off" and deleting the message undo it.
    const rvl = await page.evaluate(async () => {
        const c = SillyTavern.getContext(), m = await import('/scripts/extensions/third-party/WorldScrawl/index.js'), n0 = c.chat.length;
        const sc = [m.revealScope('region', ['a:x/1', 'a:y/2', 'b:z/3'], 'a:x/1'), m.revealScope('subregion', ['a:x/1', 'a:y/2'], 'a:x/1'), m.revealScope('a:y', ['a:x/1', 'a:y/2'], 'a:x/1'), m.revealScope('b', ['a:x/1', 'b:z/3'], 'a:x/1'), m.revealScope('a:x/1', ['a:x/1', 'a:x/2'], '')];
        const known0 = await m.knownText();
        const t = await c.executeSlashCommandsWithOptions('/ws-reveal all'); await new Promise(r => setTimeout(r, 800));
        const msg = c.chat[c.chat.length - 1], all = msg.extra?.worldscrawl_reveal?.addresses ?? [];
        const known1 = await m.knownText();
        await c.executeSlashCommandsWithOptions('/ws-reveal off'); await new Promise(r => setTimeout(r, 500));
        const known2 = await m.knownText();
        await c.executeSlashCommandsWithOptions(`/cut ${n0}-${c.chat.length - 1}`); await new Promise(r => setTimeout(r, 800));
        return { sc, pipe: t.pipe, n: all.length, kind: msg.extra?.worldscrawl_notice_kind, b0: known0.split('. Seen')[0].split(',').length, b1: known1.split('. Seen')[0].split(',').length, b2: known2.split('. Seen')[0].split(',').length };
    });
    check('/ws-reveal scopes: region, subregion, a subregion id, a region id, a place id', JSON.stringify(rvl.sc) === JSON.stringify([['a:x/1', 'a:y/2'], ['a:x/1'], ['a:y/2'], ['b:z/3'], ['a:x/1']]), JSON.stringify(rvl.sc));
    check('/ws-reveal all: one stamped message; every place counts as been-there; off undoes it', rvl.kind === 'reveal' && rvl.n > 10 && rvl.b1 >= rvl.n && rvl.b1 > rvl.b0 && rvl.b2 === rvl.b0 && /revealed/.test(rvl.pipe ?? ''), JSON.stringify(rvl));
    // ---- Tools / Debug menus and the Prompt Editor (in the map window).
    {
        const answers = []; // queued answers for confirm()/prompt() dialogs: true/false or a string
        const dlg = async d => { const a = answers.length ? answers.shift() : false; if (a === false) await d.dismiss(); else await d.accept(typeof a === 'string' ? a : undefined); };
        ui.on('dialog', dlg);
        const bar = await ui.evaluate(() => { const b = document.getElementById('topbar'); return { afterBrand: b.querySelector('.brand').nextElementSibling?.id, last: b.lastElementChild?.id }; });
        check('top bar: Tools menu right after WorldScrawl, Debug menu at the far right', bar.afterBrand === 'menu-tools' && bar.last === 'menu-debug', JSON.stringify(bar));
        await ui.click('#menu-tools .menu-title');
        const items = await ui.locator('#menu-tools .menu-item').allTextContents();
        check('Tools menu lists Prompt Editor', items.some(t => t.includes('Prompt Editor')), JSON.stringify(items));
        await ui.click('#menu-tools [data-item="prompts"]');
        await ui.waitForSelector('.pe-card', { timeout: 10000 });
        const view = await ui.evaluate(() => ({ hidden: document.getElementById('windows').hidden, cards: document.querySelectorAll('.pe-card').length, close: !!document.querySelector('.toolview-close'), resize: getComputedStyle(document.querySelector('.pe-text')).resize, sel: document.querySelector('.pe-profile').value }));
        check('Prompt Editor takes over the view with a Close button; one card per prompt; textareas resize vertically; on Default', view.hidden && view.cards >= 60 && view.close && view.resize === 'vertical' && view.sel === 'Default', JSON.stringify(view));
        const grp = await ui.evaluate(() => [...document.querySelectorAll('details.pe-group')].map(d => ({ id: d.dataset.group, open: d.open, count: d.querySelector('.pe-count')?.textContent, flow: !!d.querySelector('.pe-flow')?.textContent.trim(), pieces: !!d.querySelector('details.pe-pieces') })));
        check('prompts are in groups (Writing style open, the rest collapsed) with flow text and a prompt count', grp.length === 10 && grp[0].id === 'style' && grp[0].open && grp.slice(1).every(g => !g.open) && grp.every(g => /\d+ prompts?/.test(g.count) && g.flow) && grp.find(g => g.id === 'style')?.pieces && grp.some(g => g.id === 'npc'), JSON.stringify(grp));
        const openAll = () => ui.evaluate(() => document.querySelectorAll('details.pe-group, details.pe-pieces').forEach(d => { d.open = true; }));
        await openAll(); await ui.waitForTimeout(200);
        const lk = await ui.evaluate(() => { const c = document.querySelector('.pe-card[data-id="intent.system"]'); return { lock: !!c.querySelector('.pe-lock'), why: c.querySelector('.pe-locked')?.textContent, ro: c.querySelector('.pe-text').readOnly, shown: c.offsetHeight > 0 }; });
        check('locked prompts show a padlock, the reason and a read-only box', lk.lock && lk.why && lk.ro && lk.shown, JSON.stringify(lk));
        const card = id => ui.locator(`.pe-card[data-id="${id}"]`);
        // Debug > Unlock locked prompts (off by default) makes them editable; left on for the edit checks below.
        await ui.click('#menu-debug .menu-title');
        const u0 = await ui.locator('#menu-debug [data-item="unlock-prompts"]').getAttribute('aria-checked');
        await ui.click('#menu-debug [data-item="unlock-prompts"]'); await ui.waitForTimeout(300);
        const ro1 = await card('intent.system').locator('.pe-text').evaluate(t => t.readOnly);
        check('Debug > Unlock locked prompts (off by default) makes locked prompts editable', u0 !== 'true' && ro1 === false, JSON.stringify({ u0, ro1 }));
        await ui.keyboard.press('Escape').catch(() => {});
        const orig = await card('expand.system').locator('.pe-text').inputValue();
        answers.push(true, 'E2E');
        await card('expand.system').locator('.pe-text').focus();
        await ui.waitForFunction(() => document.querySelector('.pe-profile')?.value === 'E2E', null, { timeout: 10000 }).catch(() => {});
        check('editing on Default asks to make a profile first, then uses it', await ui.locator('.pe-profile').inputValue() === 'E2E');
        await card('expand.system').locator('.pe-text').fill(orig + '\nE2E-MARK');
        await card('expand.system').locator('.pe-submit').click();
        await ui.waitForSelector('.pe-card[data-id="expand.system"] .pe-overridden', { timeout: 10000 });
        const marked = await page.waitForFunction(async () => (await import('/scripts/extensions/third-party/WorldScrawl/index.js')).expandSys().includes('E2E-MARK'), null, { timeout: 10000 }).then(() => true).catch(() => false);
        check('Submit saves an override (marked edited) and SillyTavern uses it right away', marked);
        await card('expand.system').locator('.pe-text').fill('scratch');
        await card('expand.system').locator('.pe-undo').click();
        check('Undo edits goes back to the last saved text', (await card('expand.system').locator('.pe-text').inputValue()) === orig + '\nE2E-MARK');
        // One tool at a time: the map button (or another view / Tools item) closes the editor, asking about unsaved edits.
        const reopen = async () => { await ui.click('#menu-tools .menu-title'); await ui.click('#menu-tools [data-item="prompts"]'); await ui.waitForSelector('.pe-card', { timeout: 10000 }); await openAll(); await ui.waitForTimeout(200); };
        const mapBtn = '#windowButtons [data-window]';
        await card('expand.system').locator('.pe-text').fill(orig + '\nE2E-MARK\nSAVED');
        await ui.click(mapBtn);
        await ui.waitForSelector('.ws-choose', { timeout: 5000 }).catch(() => {});
        const choices = await ui.locator('.ws-choose button').allTextContents();
        await ui.click('.ws-choose [data-choice="Stay"]');
        const stayed = await ui.evaluate(() => !!document.querySelector('.toolview') && document.querySelector('.pe-card[data-id="expand.system"] .pe-text').value.endsWith('SAVED'));
        await ui.click(mapBtn); await ui.click('.ws-choose [data-choice="Save"]');
        await ui.waitForFunction(() => !document.querySelector('.toolview'), null, { timeout: 10000 }).catch(() => {});
        const closed = await ui.evaluate(() => !document.querySelector('.toolview') && !document.getElementById('windows').hidden);
        await reopen();
        const saved = (await card('expand.system').locator('.pe-text').inputValue()).endsWith('SAVED');
        await card('expand.system').locator('.pe-text').fill('discard me');
        await ui.click('#menu-tools .menu-title'); await ui.click('#menu-tools [data-item="prompts"]');
        await ui.click('.ws-choose [data-choice="Discard"]');
        await ui.waitForSelector('.pe-card', { timeout: 10000 }); await openAll(); await ui.waitForTimeout(200);
        const discarded = (await card('expand.system').locator('.pe-text').inputValue()).endsWith('SAVED') && await ui.locator('.toolview').count() === 1;
        check('leaving the editor with unsaved edits asks Save / Discard / Stay (Stay keeps it, Save submits then switches, Discard drops them); one tool at a time',
            JSON.stringify(choices) === '["Save","Discard","Stay"]' && stayed && closed && saved && discarded, JSON.stringify({ choices, stayed, closed, saved, discarded }));
        await card('travel.question').locator('.pe-text').fill('no placeholders here');
        const warn = await card('travel.question').locator('.pe-warn').textContent();
        answers.push(false);
        await card('travel.question').locator('.pe-submit').click(); await ui.waitForTimeout(500);
        check('removing a required placeholder warns, and asks before saving (declined: not saved)', /said/.test(warn) && await card('travel.question').locator('.pe-overridden').count() === 0, warn);
        await card('travel.question').locator('.pe-undo').click();
        const ec = await ui.locator('details.pe-group[data-group="style"] .pe-edited-count').textContent();
        check('a group shows how many of its prompts are edited', /1 edited/.test(ec), ec);
        // An older default under the override: the editor shows "default changed" with a diff.
        const fs = await import('node:fs'), f = E2E_TMP + '/st-ws/default-user/worldscrawl/prompts.json';
        const store = JSON.parse(fs.readFileSync(f, 'utf8')); const o = store.profiles.E2E.overrides['expand.system'];
        o.base_text = 'AN OLDER DEFAULT LINE\n' + o.base_text; o.base_hash = 'older'; fs.writeFileSync(f, JSON.stringify(store));
        await ui.click('.toolview-close');
        check('Close brings the map back', await ui.evaluate(() => !document.getElementById('windows').hidden && !document.querySelector('.toolview')));
        await ui.click('#menu-tools .menu-title'); await ui.click('#menu-tools [data-item="prompts"]');
        await ui.waitForSelector('.pe-card', { timeout: 10000 }); await openAll();
        await ui.waitForSelector('.pe-card[data-id="expand.system"] .pe-changed', { timeout: 10000 }).catch(() => {});
        const diff = await card('expand.system').locator('.pe-diff .del').allTextContents().catch(() => []);
        check('"Default changed since you edited this" badge with a diff of the old and new default', diff.some(t => t.includes('AN OLDER DEFAULT LINE')), JSON.stringify(diff));
        answers.push(true);
        await card('expand.system').locator('.pe-reset').click();
        await ui.waitForFunction(() => !document.querySelector('.pe-card[data-id="expand.system"] .pe-overridden'), null, { timeout: 10000 }).catch(() => {});
        const back = await page.waitForFunction(async () => !(await import('/scripts/extensions/third-party/WorldScrawl/index.js')).expandSys().includes('E2E-MARK'), null, { timeout: 10000 }).then(() => true).catch(() => false);
        check('Reset to default removes the override (SillyTavern back on the default)', back && (await card('expand.system').locator('.pe-text').inputValue()) === orig);
        answers.push('E2E 2');
        await ui.click('.pe-rename');
        await ui.waitForFunction(() => document.querySelector('.pe-profile')?.value === 'E2E 2', null, { timeout: 10000 }).catch(() => {});
        answers.push(true);
        await ui.click('.pe-delete');
        await ui.waitForFunction(() => document.querySelector('.pe-profile')?.value === 'Default', null, { timeout: 10000 }).catch(() => {});
        const left = await ui.evaluate(() => [...document.querySelectorAll('.pe-profile option')].map(o => o.value));
        check('Rename and Delete a profile (back on Default)', JSON.stringify(left) === '["Default"]', JSON.stringify(left));
        await ui.click('#menu-debug .menu-title'); await ui.click('#menu-debug [data-item="unlock-prompts"]'); await ui.waitForTimeout(300);
        await openAll();
        const ro2 = await card('intent.system').locator('.pe-text').evaluate(t => t.readOnly);
        check('turning Unlock locked prompts off makes them read-only again', ro2 === true);
        await ui.keyboard.press('Escape').catch(() => {});
        await ui.click('.toolview-close');
        // Debug menu.
        const st = () => page.evaluate(() => !!SillyTavern.getContext().extensionSettings.worldscrawl.showEditMessages);
        await ui.click('#menu-debug .menu-title');
        const c0 = await ui.locator('#menu-debug [data-item="show-edit-messages"]').getAttribute('aria-checked');
        await ui.click('#menu-debug [data-item="show-edit-messages"]');
        const on = await page.waitForFunction(() => !!SillyTavern.getContext().extensionSettings.worldscrawl.showEditMessages, null, { timeout: 5000 }).then(() => true).catch(() => false);
        await ui.waitForTimeout(600); await ui.click('#menu-debug .menu-title');
        const c1 = await ui.locator('#menu-debug [data-item="show-edit-messages"]').getAttribute('aria-checked');
        const mark = await ui.locator('#menu-debug [data-item="show-edit-messages"] .menu-check').textContent();
        await ui.click('#menu-debug [data-item="show-edit-messages"]'); await ui.waitForTimeout(600);
        check('Debug > Show map edit messages toggles the setting, with a checkmark', c0 === 'false' && on && c1 === 'true' && mark === '✓' && !(await st()), JSON.stringify({ c0, on, c1, mark }));
        const n0 = await page.evaluate(() => SillyTavern.getContext().chat.length);
        answers.push(false);
        await ui.click('#menu-debug .menu-title'); await ui.click('#menu-debug [data-item="reveal-map"]'); await ui.waitForTimeout(800);
        const nNo = await page.evaluate(() => SillyTavern.getContext().chat.length);
        answers.push(true);
        await ui.click('#menu-debug .menu-title'); await ui.click('#menu-debug [data-item="reveal-map"]');
        await page.waitForFunction(n => SillyTavern.getContext().chat.length > n, n0, { timeout: 10000 }).catch(() => {});
        const rev = await page.evaluate(n => { const c = SillyTavern.getContext(), m = c.chat[c.chat.length - 1]; return { grew: c.chat.length > n, kind: m.extra?.worldscrawl_notice_kind, n: m.extra?.worldscrawl_reveal?.addresses?.length ?? 0 }; }, n0);
        check('Debug > Reveal map asks first (cancel does nothing), then reveals like /ws-reveal all', nNo === n0 && rev.grew && rev.kind === 'reveal' && rev.n > 10, JSON.stringify({ nNo, n0, rev }));
        await page.evaluate(async n => { const c = SillyTavern.getContext(); await c.executeSlashCommandsWithOptions(`/cut ${n}-${c.chat.length - 1}`); }, n0); await page.waitForTimeout(800);
        ui.off('dialog', dlg);
    }
    check('map window raised no page errors', uiErrors.length === 0, JSON.stringify(uiErrors));
    await ui.close();
    const popup = page.waitForEvent('popup', { timeout: 10000 }).catch(() => null);
    await page.evaluate(() => SillyTavern.getContext().executeSlashCommandsWithOptions('/ws-map'));
    const pop = await popup; if (pop) await pop.waitForURL(/worldscrawl\/ui\//, { timeout: 10000 }).catch(() => {});
    check('/ws-map opens the map window', !!pop && /\/api\/plugins\/worldscrawl\/ui\/$/.test(pop.url()), pop?.url());
    await pop?.close();
    const cacheRes = await (await stFetch('/cache/clear', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json();
    const cacheStats = await (await stFetch('/cache')).json();
    check('map cache: Debug clear empties it', cacheRes.cleared === true && cacheRes.checkpoints > 0 && cacheStats.checkpoints === 0 && cacheStats.built === 0, JSON.stringify([cacheRes, cacheStats]));
    check('settings panel has an Open WorldScrawl GUI button on one line', await page.evaluate(() => { const b = document.getElementById('worldscrawl_open_map'); return !!b && b.textContent.trim() === 'Open WorldScrawl GUI' && getComputedStyle(b).whiteSpace === 'nowrap'; }));
    // NPCs: cast file, remember card, a fact stamp's bar, and 12-hour waits parsed with no extra model call.
    const cast0 = await (await stFetch('/cast')).json();
    check('cast: Hesk loads from worlds/riverton/cast', cast0.npcs?.some(n => n.id === 'hesk' && n.ok && n.schedule?.length === 2) && !cast0.problems?.length, JSON.stringify(cast0.problems ?? []));
    const reqsBeforeNpc = (await (await fetch(`${FAKE}/__requests`)).json()).length;
    // The remember call is prefetched as soon as the card shows, so its answer is queued first.
    await queue([{ content: '{"name":"Maren","unknownAs":"the knife-grinder","personality":{"summary":"A traveling knife-grinder with a squeaky cart."},"appearance":{"summary":"wiry woman with a cart","outfit":"a patched smock"},"invented":["grey eyes"]}' }]);
    await page.evaluate(() => SillyTavern.getContext().executeSlashCommandsWithOptions('/ws-npc Maren'));
    await page.waitForTimeout(500);
    await page.waitForFunction(() => !!document.querySelector('.worldscrawl_remembercard .worldscrawl_remember_proposal'), null, { timeout: 10000 }).catch(() => {});
    const prop = await page.evaluate(() => {
        const card = [...document.querySelectorAll('.worldscrawl_remembercard')].pop();
        const m = [...SillyTavern.getContext().chat].reverse().find(x => x.extra?.worldscrawl_remember);
        return { head: card?.querySelector('.worldscrawl_remember_head')?.textContent ?? '', invented: card?.querySelector('.worldscrawl_invented')?.textContent ?? '', cached: !!m?.extra?.worldscrawl_remember?.proposal?.got };
    });
    const reqsPrefetched = (await (await fetch(`${FAKE}/__requests`)).json()).length;
    check('remember prefetch: the card shows the proposed person (name, unknownAs, summaries, invented marked), cached on the message, one call', /Maren \(shown as "the knife-grinder"/.test(prop.head) && /squeaky cart.*wiry woman/.test(prop.head) && /⚠ grey eyes/.test(prop.invented) && prop.cached && reqsPrefetched === reqsBeforeNpc + 1, JSON.stringify({ ...prop, calls: reqsPrefetched - reqsBeforeNpc }));
    await page.evaluate(async () => { const m = await import('/scripts/extensions/third-party/WorldScrawl/index.js'); m.renderPatchCards(); m.renderPatchCards(); });
    await page.waitForTimeout(500);
    check('remember prefetch: redraws do not call again', (await (await fetch(`${FAKE}/__requests`)).json()).length === reqsPrefetched);
    const remembered = await page.evaluate(() => {
        const ch = SillyTavern.getContext().chat;
        const hit = [...ch].reverse().find(m => m.extra?.worldscrawl_remember?.status === 'review');
        return { name: hit?.extra?.worldscrawl_remember?.name ?? '', card: !!document.querySelector('.worldscrawl_remembercard') };
    });
    check('/ws-npc shows a Remember card', remembered.card && remembered.name === 'Maren', JSON.stringify(remembered));
    const look = await page.evaluate(() => {
        const card = [...document.querySelectorAll('.worldscrawl_remembercard')].pop();
        const row = card?.querySelector(':scope > .worldscrawl_notice_row');
        const btns = [...(card?.querySelectorAll('.worldscrawl_card_btn') ?? [])];
        return { pending: card?.classList.contains('worldscrawl_pending') && /Waiting on you/.test(card.querySelector('.worldscrawl_waiting_label')?.textContent ?? ''),
            rowLast: !!row && card.lastElementChild === row, allInRow: btns.length > 0 && btns.every(b => row?.contains(b)), right: row ? getComputedStyle(row).justifyContent : '',
            labels: btns.map(b => b.textContent) };
    });
    check('notices: the Remember card waits on you, with one right-aligned button row at the end (Approve / Adjust / Discard)', look.pending && look.rowLast && look.allInRow && look.right === 'flex-end' && look.labels.join('|') === 'Approve|Adjust|Discard', JSON.stringify(look));
    await page.locator('.worldscrawl_remembercard').last().scrollIntoViewIfNeeded();
    await page.locator('.worldscrawl_remembercard').last().screenshot({ path: process.env.E2E_SHOTS ? `${process.env.E2E_SHOTS}/notice-pending.png` : `${process.env.E2E_TMP ?? '/tmp'}/notice-pending.png` }).catch(() => {});
    const approveBtn = page.locator('.worldscrawl_remembercard .worldscrawl_card_btn', { hasText: /^Approve$/ });
    await page.evaluate(() => { window.__wsSaw = { saving: false, locked: false }; window.__wsObs = new MutationObserver(() => { const c = [...document.querySelectorAll('.worldscrawl_remembercard')].pop(); if (!c) return; if (/Saving…/.test(c.textContent)) window.__wsSaw.saving = true; const bs = [...c.querySelectorAll('.worldscrawl_card_btn')]; if (bs.length && bs.every(b => b.classList.contains('disabled'))) window.__wsSaw.locked = true; }); window.__wsObs.observe(document.getElementById('chat'), { subtree: true, childList: true, attributes: true }); });
    await approveBtn.dblclick();
    const saving = await page.evaluate(() => window.__wsSaw);
    await page.evaluate(() => { const b = [...document.querySelectorAll('.worldscrawl_remembercard .worldscrawl_card_btn')].find(x => x.textContent === 'Approve'); b?.click(); b?.click(); });
    for (let i = 0; i < 40 && (await (await fetch(`${FAKE}/__requests`)).json()).length < reqsBeforeNpc + 1; i++) await page.waitForTimeout(250);
    await page.waitForTimeout(1500);
    const dbl = await page.evaluate(() => {
        const ch = SillyTavern.getContext().chat;
        const m = [...ch].reverse().find(x => x.extra?.worldscrawl_remember);
        const res = [...document.querySelectorAll('.worldscrawl_resolved')].map(e => e.textContent);
        return { creates: ch.flatMap(x => x.extra?.worldscrawl_npc ?? []).filter(s => s.type === 'npc_create' && s.name === 'Maren').length,
            lines: [...document.querySelectorAll('.worldscrawl_npcchange')].filter(e => /Maren/.test(e.textContent)).length,
            decided: Object.entries(m?.extra?.worldscrawl_decided ?? {}).filter(([k]) => k.startsWith('remember_')).map(([, d]) => d.action), pendingLeft: !!document.querySelector('.worldscrawl_remembercard.worldscrawl_pending'), res };
    });
    await page.evaluate(() => window.__wsObs?.disconnect());
    const reqsAfterNpc = (await (await fetch(`${FAKE}/__requests`)).json()).length;
    check('notices: first click locks the row', saving.locked, JSON.stringify(saving));
    check('notices: double-clicking Approve (plus extra clicks) writes one line, one decision, and no model call beyond the prefetch', dbl.creates === 1 && dbl.lines === 1 && dbl.decided.join() === 'approve' && reqsAfterNpc === reqsBeforeNpc + 1, JSON.stringify({ ...dbl, calls: reqsAfterNpc - reqsBeforeNpc }));
    check('notices: once answered the highlight goes and the notice shows its resolved state', !dbl.pendingLeft && dbl.res.some(t => /✓ Approved: remembered Maren/.test(t)), JSON.stringify(dbl));
    const act = await page.evaluate(async () => { const { messageActivity } = await import('/scripts/extensions/third-party/WorldScrawl/activity.mjs'); const ch = SillyTavern.getContext().chat; const i = ch.findLastIndex(x => x.extra?.worldscrawl_decided); return messageActivity(ch[i], i).filter(e => /notice answered/.test(e.label)).map(e => `${e.label}: ${e.status}`); });
    check('notices: the answer shows in the activity log', act.includes('remember notice answered: approve'), JSON.stringify(act));
    await page.locator('.worldscrawl_resolved', { hasText: 'Maren' }).last().locator('xpath=..').screenshot({ path: process.env.E2E_SHOTS ? `${process.env.E2E_SHOTS}/notice-resolved.png` : `${process.env.E2E_TMP ?? '/tmp'}/notice-resolved.png` }).catch(() => {});
    const created = await page.evaluate(() => {
        const ch = SillyTavern.getContext().chat;
        const stamps = ch.flatMap(m => m.extra?.worldscrawl_npc ?? []);
        return stamps.find(s => s.type === 'npc_create');
    });
    check('Approve saves the prefetched card as an npc_create stamp', created?.id === 'maren' && /knife-grinder/.test(created.line ?? '') && created.unknownAs === 'the knife-grinder' && created.outfit === 'a patched smock', JSON.stringify(created));
    // Approve while the prefetch is still running: Preparing…, then Saving…, then exactly one model call.
    const reqsBeforeSlow = (await (await fetch(`${FAKE}/__requests`)).json()).length;
    await queue([{ content: '{"name":"Corwin","personality":{"summary":"A ferry hand."}}', delay: 3000 }]);
    await page.evaluate(() => SillyTavern.getContext().executeSlashCommandsWithOptions('/ws-npc Corwin'));
    const lastCardText = () => page.evaluate(() => [...document.querySelectorAll('.worldscrawl_remembercard')].pop()?.textContent ?? '');
    await page.waitForFunction(() => /Corwin/.test(([...document.querySelectorAll('.worldscrawl_remembercard')].pop()?.querySelector('input')?.value ?? '')) && /Preparing…/.test([...document.querySelectorAll('.worldscrawl_remembercard')].pop()?.textContent ?? ''), null, { timeout: 5000 }).catch(() => {});
    const preparing = /Preparing…/.test(await lastCardText());
    await page.locator('.worldscrawl_remembercard .worldscrawl_card_btn', { hasText: /^Approve$/ }).last().click();
    await page.waitForTimeout(300);
    const savingSlow = /Saving…/.test(await lastCardText());
    await page.waitForFunction(() => SillyTavern.getContext().chat.some(m => (m.extra?.worldscrawl_npc ?? []).some(s => s.type === 'npc_create' && s.name === 'Corwin')), null, { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(1000);
    const slow = await page.evaluate(() => SillyTavern.getContext().chat.flatMap(m => m.extra?.worldscrawl_npc ?? []).filter(s => s.type === 'npc_create' && s.name === 'Corwin').map(s => s.line));
    const reqsAfterSlow = (await (await fetch(`${FAKE}/__requests`)).json()).length;
    check('remember prefetch: Approve during the prefetch shows Preparing… then Saving…, waits, and makes exactly one call', preparing && savingSlow && slow.length === 1 && slow[0] === 'A ferry hand.' && reqsAfterSlow === reqsBeforeSlow + 1, JSON.stringify({ preparing, savingSlow, slow, calls: reqsAfterSlow - reqsBeforeSlow }));
    const actPre = await page.evaluate(async () => { const { callNotes } = await import('/scripts/extensions/third-party/WorldScrawl/calllog.mjs'); return SillyTavern.getContext().chat.flatMap(m => callNotes(m)).map(n => n.kind).filter(k => /prefetch/.test(k)); });
    check('remember prefetch: logged in the model-calls activity log', actPre.length >= 2, JSON.stringify(actPre));
    // Typed mode asks intent first. "look" makes that a look-only question, so the story reply is the second call.
    await queue([{ content: 'stay' }, { content: 'She shows a scar. [ws_npc: fact | maren | a scar on her knuckle]' }]);
    await send('I look at Maren\'s hands.', 2);
    const factBar = await page.evaluate(() => {
        const ch = SillyTavern.getContext().chat;
        const m = [...ch].reverse().find(x => (x.extra?.worldscrawl_npc ?? []).some(s => s.type === 'npc_fact'));
        const s = (m?.extra?.worldscrawl_npc ?? []).find(x => x.type === 'npc_fact');
        const text = [...document.querySelectorAll('.worldscrawl_npcchange')].map(el => el.textContent ?? '').join('\n');
        return { text, fact: s?.text ?? '', stripped: !!m && !/ws_npc/.test(m.mes ?? '') };
    });
    check('a fact tag becomes a Character changed here bar and leaves the story', /Character changed here: Maren: a scar/.test(factBar.text) && factBar.fact === 'a scar on her knuckle' && factBar.stripped, JSON.stringify(factBar));
    const factRow = page.locator('.worldscrawl_npcchange', { hasText: 'a scar' });
    await factRow.locator('.worldscrawl_card_btn', { hasText: 'Turn off' }).click();
    await page.waitForTimeout(400);
    check('Turn off keeps the fact but stops using it', await page.evaluate(() => SillyTavern.getContext().chat.some(m => (m.extra?.worldscrawl_npc ?? []).some(s => s.type === 'npc_fact' && s.off === true))));
    await queue([{ content: 'stay' }, { content: 'Maren narrows her eyes. [ws_npc: memory | maren | The stranger lied to me about the knife.] [ws_npc: disposition | maren | unfriendly | caught in a lie]' }]);
    await send('I lie to Maren about the knife.', 2);
    const mdBar = await page.evaluate(() => {
        const m = [...SillyTavern.getContext().chat].reverse().find(x => (x.extra?.worldscrawl_npc ?? []).some(s => s.type === 'npc_disposition'));
        const rows = [...document.querySelectorAll('.worldscrawl_npcchange')].filter(el => /lied to me about the knife|caught in a lie/.test(el.textContent ?? ''));
        return { types: (m?.extra?.worldscrawl_npc ?? []).map(s => s.type), stripped: !!m && !/ws_npc/.test(m.mes ?? ''), rows: rows.map(r => ({ t: r.textContent, b: [...r.querySelectorAll('.worldscrawl_card_btn')].map(b => b.textContent) })) };
    });
    check('memory and disposition tags: stamped, stripped, each a notice with Edit and Turn off', mdBar.types.includes('npc_memory') && mdBar.types.includes('npc_disposition') && mdBar.stripped
        && ['lied to me about the knife', 'caught in a lie'].every(w => mdBar.rows.some(r => r.t.includes(w) && r.b.includes('Edit') && r.b.includes('Turn off'))), JSON.stringify(mdBar));
    await queue([{ content: 'stay' }, { content: 'Maren shrugs. [WS_Memory|maren|The stranger shrugged at me.] [ws_bogus | huh]' }]);
    await send('I shrug at Maren.', 2);
    await page.waitForTimeout(400);
    const lt = await page.evaluate(() => {
        const ch = SillyTavern.getContext().chat; const m = ch.slice(-1)[0];
        const el = document.querySelector(`#chat .mes[mesid="${ch.length - 1}"] .worldscrawl_badtag`);
        return { mes: m.mes, mem: (m.extra?.worldscrawl_npc ?? []).some(s => s.type === 'npc_memory' && /shrugged/.test(s.note ?? s.text ?? '')), bad: m.extra?.worldscrawl_badtags ?? null, mark: el ? { t: el.textContent, title: el.title } : null,
            call: JSON.stringify(m.extra?.worldscrawl_calls ?? m.extra ?? {}).includes('unreadable tag: [ws_bogus | huh]') };
    });
    check('lenient tag: [WS_Memory|...] read and hidden; unreadable [ws_bogus] stays visible, marked, and logged as a warning',
        lt.mem && !/WS_Memory/i.test(lt.mes) && /\[ws_bogus \| huh\]/.test(lt.mes) && lt.bad?.[0]?.tags?.[0] === '[ws_bogus | huh]' && lt.mark?.title === "WorldScrawl couldn't read this tag" && lt.call, JSON.stringify(lt));
    await factRow.locator('.worldscrawl_card_btn', { hasText: 'Undo' }).click();
    await page.waitForTimeout(400);
    check('Undo removes the fact stamp', await page.evaluate(() => !SillyTavern.getContext().chat.some(m => (m.extra?.worldscrawl_npc ?? []).some(s => s.type === 'npc_fact'))));
    // The narrator flags people itself ([ws_flag: npc | Name]); no name scanning, so a date header is never offered.
    const flagReply = n => `**Saturday, 9 PM**\nBrannoc the ferryman leans in and asks how your crossing was (${n}); Ysolde pours. [ws_flag: npc | Brannoc] [ws_flag: npc | Ysolde]`;
    await queue([{ content: 'stay' }, { content: flagReply(1) }]); await send('I nod.', 2);
    await queue([{ content: 'stay' }, { content: flagReply(2) }]); await send('I nod again.', 2);
    const fl2 = await page.evaluate(async () => {
        const m = await import('/scripts/extensions/third-party/WorldScrawl/index.js'); const ch = SillyTavern.getContext().chat;
        return { rows: m.flaggedInScene(ch, ch.length - 1), shown: ch.slice(-1)[0].mes, card: ch.some(x => /Brannoc|Saturday/.test(x.extra?.worldscrawl_remember?.name ?? '')) };
    });
    check('npc flags: tag stripped, counted, no card before 3, never Saturday', !/ws_flag/.test(fl2.shown) && fl2.rows.length === 2 && fl2.rows[0].name === 'Brannoc' && fl2.rows.every(r => r.count === 2) && !fl2.card, JSON.stringify(fl2));
    await page.evaluate(() => SillyTavern.getContext().executeSlashCommandsWithOptions('/ws-npc'));
    await page.waitForTimeout(500);
    const bare = await page.evaluate(() => { const ch = SillyTavern.getContext().chat; return ch.slice(-1)[0].extra?.worldscrawl_remember ?? null; });
    check('bare /ws-npc targets the most recently flagged unsaved person', bare?.name === 'Brannoc' && bare.status === 'review' && !bare.suggested, JSON.stringify(bare));
    await page.locator('.worldscrawl_remembercard .worldscrawl_card_btn', { hasText: 'Discard' }).last().click();
    await page.waitForTimeout(400);
    await queue([{ content: 'stay' }, { content: flagReply(3) }]); await send('I shrug.', 2);
    const fl3 = await page.evaluate(() => { const ch = SillyTavern.getContext().chat; return ch.slice(-1)[0].extra?.worldscrawl_remember ?? null; });
    check('third flag shows a Remember card, but not for the scene no', fl3?.name === 'Ysolde' && fl3.suggested === true, JSON.stringify(fl3));
    const beforeWait = (await (await fetch(`${FAKE}/__requests`)).json()).length;
    expected += 1;
    await page.evaluate(() => SillyTavern.getContext().executeSlashCommandsWithOptions('/ws-wait until 5pm'));
    await waitReqs();
    const five = await page.evaluate(() => { const ch = SillyTavern.getContext().chat; const u = [...ch].reverse().find(m => m.extra?.worldscrawl_wait); return u?.extra?.worldscrawl_wait ?? null; });
    const afterWait = (await (await fetch(`${FAKE}/__requests`)).json()).length;
    check('/ws-wait until 5pm parses with no extra model call', five?.until === '17:00' && five.seconds > 0 && afterWait === beforeWait + 1, JSON.stringify({ five, calls: afterWait - beforeWait }));
    await page.locator('.worldscrawl_npcchange', { hasText: 'remembered' }).filter({ hasText: 'Maren' }).locator('.worldscrawl_card_btn', { hasText: 'Export' }).first().click();
    await page.waitForTimeout(600);
    const exportWorld = await M(m => m.effectiveWorld());
    const cast1 = await (await stFetch(`/cast?world=${encodeURIComponent(exportWorld || '')}`)).json();
    check('Export to cast writes Maren without replacing Hesk', cast1.npcs?.some(n => n.id === 'hesk') && cast1.npcs?.some(n => n.id === 'maren' && /knife-grinder/.test(n.line ?? '')), JSON.stringify({ world: exportWorld, ids: cast1.npcs?.map(n => n.id) }));
    await queue([{ content: 'stay' }, { content: 'She taps the bar. [ws_npc: fact | hesk | a knife under the bar]' }]);
    await send('I ask what Hesk keeps under the bar.', 2);
    const knife = page.locator('.worldscrawl_npcchange', { hasText: 'a knife under the bar' });
    await knife.locator('.worldscrawl_card_btn', { hasText: 'Update Hesk' }).click();
    await page.waitForTimeout(200);
    const diffText = await knife.locator('.worldscrawl_castdiff').innerText();
    check('Update Hesk shows a diff against the cast file', /facts/.test(diffText) && /a knife under the bar/.test(diffText), diffText);
    await knife.locator('.worldscrawl_card_btn', { hasText: 'Confirm' }).click();
    await page.waitForTimeout(600);
    const cast2 = await (await stFetch(`/cast?world=${encodeURIComponent(exportWorld || '')}`)).json();
    const heskNow = cast2.npcs?.find(n => n.id === 'hesk');
    check('Update writes Hesk in place and does not add hesk-2', heskNow?.facts?.includes('a knife under the bar') && cast2.npcs?.some(n => n.id === 'maren') && !cast2.npcs?.some(n => n.id === 'hesk-2'), JSON.stringify(cast2.npcs?.map(n => n.id)));
    // ---- Phase 1.5: the map's Cast browser / editor. Saves go through /cast/save and /cast/delete; Update goes through the tab.
    const cw = await page.context().newPage(); await cw.setViewportSize({ width: 1300, height: 850 });
    cw.on('pageerror', e => { uiErrors.push(e.message); console.log('[cast pageerror]', e.message); });
    for (let i = 0; i < 3; i++) {
        const r = await cw.goto(BASE + 'api/plugins/worldscrawl/ui/').catch(e => { console.log('[cast goto]', e.message); return null; });
        if (await cw.waitForSelector('#castToggle', { timeout: 10000 }).then(() => true, () => false)) break;
        console.log('[cast window] no Cast button yet:', r?.status(), (await cw.content().catch(() => '')).slice(0, 300));
    }
    try { await cw.waitForSelector('.node.here', { timeout: 15000 }); } catch {}
    await cw.locator('#castToggle').click();
    try { await cw.waitForSelector('.castpanel .cast-row[data-id="hesk"]', { timeout: 10000 }); } catch {}
    const castIds = await cw.evaluate(() => [...document.querySelectorAll('.castpanel .cast-row')].map(r => r.dataset.id));
    check('Cast panel lists the cast (Hesk, Maren)', castIds.includes('hesk') && castIds.includes('maren'), JSON.stringify(castIds));
    await cw.locator('.cast-q').fill('landlady');
    const searched = await cw.evaluate(() => [...document.querySelectorAll('.castpanel .cast-row')].map(r => r.dataset.id));
    check('Cast search filters by line', searched.join() === 'hesk', JSON.stringify(searched));
    // An unsaved cast edit survives a trip to the Editor and back.
    await cw.evaluate(() => wsCast.selectId('hesk', 'edit')); await cw.waitForTimeout(400);
    await cw.locator('.castform .cf-row[data-field="unknownAs"] input').fill('the scarred landlady');
    await cw.locator('#editorToggle').click(); await cw.waitForTimeout(1200);
    const cs1 = await cw.evaluate(() => ({ casting: document.body.classList.contains('casting'), editor: document.body.classList.contains('editor'), cast: !!document.querySelector('.side .castpanel') }));
    await cw.locator('#castToggle').click(); await cw.waitForTimeout(1200);
    const cs2 = await cw.evaluate(() => ({ casting: document.body.classList.contains('casting'), editor: document.body.classList.contains('editor'), v: document.querySelector('.side .castform .cf-row[data-field="unknownAs"] input')?.value, editing: wsCast.isEditing() }));
    check('opening Editor from a cast edit hides Cast; reopening Cast restores the unsaved edit', !cs1.casting && cs1.editor && !cs1.cast && cs2.casting && !cs2.editor && cs2.v === 'the scarred landlady' && cs2.editing, JSON.stringify([cs1, cs2]));
    await cw.locator('.castform .cast-cancel').click(); await cw.waitForTimeout(300);
    await cw.locator('.cast-q').fill('');
    const markCount = await cw.locator('.npcmark').count();
    await cw.locator('.npctoggle').uncheck();
    const markOff = await cw.locator('.npcmark').count();
    await cw.locator('.npctoggle').check();
    check('NPC markers show on the map and the legend toggle hides them', markCount > 0 && markOff === 0 && await cw.locator('.npcmark').count() === markCount, JSON.stringify([markCount, markOff]));
    await cw.locator('.node[data-id="riverton:drowned_rat/common_room"] rect').first().click({ force: true });
    await cw.waitForTimeout(300);
    const placeFilt = await cw.evaluate(() => ({ ids: [...document.querySelectorAll('.castpanel .cast-row')].map(r => r.dataset.id), pf: document.querySelector('.cast-placefilter')?.dataset.value }));
    check('clicking a room filters the cast by that place', placeFilt.pf === 'riverton:drowned_rat/common_room' && placeFilt.ids.includes('hesk'), JSON.stringify(placeFilt));
    await cw.evaluate(() => document.querySelector('.cast-placefilter').setValue(''));
    // In play: a new fact in the chat, its stamp links back to the message, and Update shows the diff.
    await queue([{ content: 'stay' }, { content: 'She glares at a rat. [ws_npc: fact | hesk | hates rats]' }]);
    await send('I point at the rat by the hearth.', 2);
    await cw.waitForTimeout(1200);
    await cw.evaluate(() => wsCast.selectId('hesk', 'play'));
    await cw.waitForTimeout(200);
    const stampsTxt = await cw.locator('.cast-stamps').innerText().catch(() => '');
    check('In play lists Hesk\'s changes with message links', /hates rats/.test(stampsTxt) && await cw.locator('.cast-stamps .cast-msglink').count() > 0, stampsTxt + ' / chat has it: ' + await page.evaluate(() => SillyTavern.getContext().chat.some(m => (m.extra?.worldscrawl_npc ?? []).some(s => s.text === 'hates rats'))));
    const whyTxt = await cw.locator('.cast-why').innerText().catch(() => '');
    check('Under the hood shows game time, why, schedule and disposition', /Game time/.test(whyTxt) && /Why/.test(whyTxt) && /Schedule/.test(whyTxt) && /Toward the player/.test(whyTxt), whyTxt);
    const hl = await cw.evaluate(() => document.querySelectorAll('.node.cast-hl').length);
    check('selecting Hesk highlights her places on the map', hl > 0, String(hl));
    const ratLink = cw.locator('.cast-stamps li', { hasText: 'hates rats' }).locator('.cast-msglink');
    const ratMsg = Number(await ratLink.getAttribute('data-msg'));
    await ratLink.click();
    await page.waitForTimeout(400);
    check('a message link flashes that message in SillyTavern', await page.evaluate(n => !!document.querySelector(`#chat .mes[mesid="${n}"]`)?.style.outline, ratMsg), String(ratMsg));
    await cw.locator('.cast-update').click();
    const mapDiff = await cw.locator('.cast-diff').innerText().catch(() => '');
    check('Update Hesk on the map shows the diff', /facts/.test(mapDiff) && /hates rats/.test(mapDiff), mapDiff);
    await cw.locator('.cast-confirm').click();
    await cw.waitForTimeout(1200);
    const cast3 = await (await stFetch(`/cast?world=${encodeURIComponent(exportWorld || '')}`)).json();
    check('map Update writes Hesk in place', cast3.npcs?.find(n => n.id === 'hesk')?.facts?.includes('hates rats') && !cast3.npcs?.some(n => n.id === 'hesk-2'), JSON.stringify(cast3.npcs?.map(n => [n.id, n.facts])));
    // Who's here, what the narrator was told, and the unsaved list.
    await cw.evaluate(() => wsCast.selectPlace('riverton:drowned_rat/common_room'));
    await cw.waitForTimeout(200);
    const whoTxt = await cw.locator('.cast-who').innerText().catch(() => '');
    check('Who\'s here lists Hesk for the common room with a reason', /Who's here/.test(whoTxt) && /Hesk/.test(whoTxt), whoTxt);
    await cw.evaluate(() => wsCast.selectPlace(''));
    await cw.evaluate(() => wsCast.setView('narrator'));
    await cw.waitForTimeout(200);
    const narrV = await cw.evaluate(() => ({ slices: document.querySelectorAll('.cast-view .cast-slice').length, opts: document.querySelectorAll('.cast-narrsel option').length, txt: document.querySelector('.cast-view')?.innerText ?? '' }));
    check('What the narrator was told shows both slices for the latest reply', narrV.slices === 2 && narrV.opts > 0 && /npcs_present/.test(narrV.txt), JSON.stringify(narrV).slice(0, 400));
    await cw.evaluate(() => wsCast.setView('unsaved'));
    await cw.waitForTimeout(200);
    const unsTxt = await cw.locator('.cast-view').innerText().catch(() => '');
    check('Not saved yet shows the Remember threshold', /after 3 replies/.test(unsTxt), unsTxt);
    check('Activity log is no longer a Cast view', await cw.locator('.castpanel [data-view="activity"]').count() === 0);
    await cw.locator('#menu-debug .menu-title').click(); await cw.locator('#menu-debug [data-item="activity-log"]').click();
    await cw.locator('#tool-activity .act-sel').waitFor({ timeout: 10000 }).catch(() => {});
    check('Debug > Activity log opens its own view; the map, Cast and Editor panes are hidden under it', await cw.evaluate(() => !!document.querySelector('#tool-activity') && document.getElementById('windows').hidden), '');
    const actV = await cw.evaluate(() => ({ opts: document.querySelectorAll('.act-sel option').length, first: document.querySelector('.act-sel option')?.textContent ?? '', all: [...document.querySelectorAll('.act-sel option')].map(o => o.value) }));
    let actHit = '';
    for (const v of actV.all) { const t = await cw.evaluate(val => { const s = document.querySelector('.act-sel'); s.value = val; s.dispatchEvent(new Event('change')); return document.querySelector('#tool-activity')?.innerText ?? ''; }, v); if (/Map stamps|Flags|Rolls|Cards|Positions|People/.test(t)) { actHit = t; break; } }
    check('Activity log lists messages (latest first) and shows recorded engine activity', actV.opts > 0 && /latest/.test(actV.first) && !!actHit, JSON.stringify(actV).slice(0, 300) + ' | ' + actHit.slice(0, 300));
    const callTxt = await cw.evaluate(async () => { const s = document.querySelector('.act-sel'); for (const o of s.options) { s.value = o.value; s.dispatchEvent(new Event('change')); const t = document.querySelector('#tool-activity')?.innerText ?? ''; if (/Model calls/.test(t) && /narrator reply/.test(t)) return t; } return ''; });
    check('Activity log shows the persisted model-call notes', /Model calls/.test(callTxt) && /narrator reply: ok/.test(callTxt), callTxt.slice(0, 400));
    await cw.locator('#castToggle').click(); await cw.waitForTimeout(800);
    check('clicking Cast closes the Activity log view and shows Cast again', await cw.evaluate(() => !document.querySelector('#tool-activity') && !document.getElementById('windows').hidden && !!document.querySelector('.side .castpanel') && document.body.classList.contains('casting')));
    await cw.evaluate(() => wsCast.setView('people'));
    // "In this chat": a memory saved as a stamp on the latest message, after a diff.
    await cw.evaluate(() => wsCast.selectId('hesk', 'chatedit'));
    await cw.waitForTimeout(200);
    const memBox = cw.locator('.cf-row[data-field="memory"] textarea');
    await memBox.fill(((await memBox.inputValue()) + '\npointed at the rat').trim());
    await cw.locator('.cast-save').click();
    const chatDiff = await cw.locator('.cast-review').innerText().catch(() => '');
    check('In this chat shows the stamps before saving', /memory: pointed at the rat/.test(chatDiff), chatDiff);
    await cw.locator('.cast-review .cast-confirm').click();
    await cw.waitForTimeout(1200);
    const chatMem = await page.evaluate(() => { const ch = SillyTavern.getContext().chat; return (ch[ch.length - 1].extra?.worldscrawl_npc ?? []).some(s => s.type === 'npc_memory' && s.note === 'pointed at the rat' && s.id === 'hesk'); });
    check('In this chat saves a Character changed here stamp on the latest message', chatMem);
    // The editor: Hesk's second schedule entry moves to the courtyard via the map picker field.
    await cw.evaluate(() => wsCast.selectId('hesk', 'edit'));
    await cw.waitForTimeout(200);
    await pickSet(cw.locator('.cf-sched[data-i="1"] .wspick'), 'riverton:drowned_rat/courtyard');
    await cw.locator('.cf-sched[data-i="1"] .cf-activity').fill('feeding the hens');
    await cw.locator('.cf-sched[data-i="1"] .cf-from').fill('07:00');
    await cw.locator('.cf-sched[data-i="1"] .cf-to').fill('09:00');
    await cw.locator('.cast-save').click();
    const baseDiff = await cw.locator('.cast-review').innerText().catch(() => '');
    check('Base (cast file) shows the diff before saving', /schedule/.test(baseDiff) && /feeding the hens/.test(baseDiff), baseDiff);
    await cw.locator('.cast-review .cast-confirm').click();
    await cw.waitForTimeout(1000);
    const cast4 = await (await stFetch(`/cast?world=${encodeURIComponent(exportWorld || '')}`)).json();
    const hs = cast4.npcs?.find(n => n.id === 'hesk')?.schedule ?? [];
    check('editor saves Hesk\'s schedule through /cast/save', hs[1]?.place === 'riverton:drowned_rat/courtyard' && hs[1]?.activity === 'feeding the hens' && hs[1]?.from === '07:00' && hs[0]?.importance === 'high', JSON.stringify(hs));
    // New person: inline validation, then create and delete with a confirm.
    await cw.locator('.cast-new').click();
    await cw.locator('.cf-row[data-field="name"] input').fill('Pip');
    await cw.locator('.cf-row[data-field="line"] input').fill('A barefoot errand boy.');
    await cw.locator('.cf-row[data-field="id"] input').fill('hesk');
    const dupErr = await cw.locator('.cf-err[data-for="id"]').innerText();
    const dupDisabled = await cw.locator('.cast-save').isDisabled();
    await cw.locator('.cf-row[data-field="id"] input').fill('Bad Id');
    const slugErr = await cw.locator('.cf-err[data-for="id"]').innerText();
    check('editor flags a used id and a bad slug, and Save is disabled', !!dupErr && !!slugErr && dupDisabled && await cw.locator('.cast-save').isDisabled(), JSON.stringify([dupErr, slugErr]));
    await cw.locator('.cf-row[data-field="id"] input').fill('pip');
    await cw.locator('.cf-addsched').click();
    await cw.locator('.cf-sched[data-i="0"] .cf-activity').fill('running errands');
    const noPlace = await cw.locator('.cast-save').isDisabled() && !!(await cw.locator('.cf-err[data-for="schedule.0.place"]').innerText());
    check('a schedule entry with no place disables Save', noPlace);
    await pickSet(cw.locator('.cf-sched[data-i="0"] .wspick'), 'riverton:streets/square');
    await cw.locator('.cast-save').click();
    await cw.locator('.cast-review .cast-confirm').click();
    await cw.waitForTimeout(1000);
    const cast5 = await (await stFetch(`/cast?world=${encodeURIComponent(exportWorld || '')}`)).json();
    check('Create writes cast/pip.json', cast5.npcs?.some(n => n.id === 'pip' && n.schedule?.[0]?.place === 'riverton:streets/square'), JSON.stringify(cast5.npcs?.map(n => n.id)));
    await cw.evaluate(() => wsCast.selectId('pip', 'summary'));
    await cw.locator('.cast-del').click();
    await cw.locator('.cast-delyes').click();
    await cw.waitForTimeout(1000);
    const cast6 = await (await stFetch(`/cast?world=${encodeURIComponent(exportWorld || '')}`)).json();
    check('Delete (after the confirm) removes Pip', !cast6.npcs?.some(n => n.id === 'pip') && cast6.npcs?.some(n => n.id === 'hesk'), JSON.stringify(cast6.npcs?.map(n => n.id)));
    await cw.screenshot({ path: '/tmp/ws-e2e-cast.png' });
    await cw.close();
    await page.evaluate(() => { SillyTavern.getContext().extensionSettings.worldscrawl.world = ''; });
    await page.screenshot({ path: '/tmp/ws-e2e.png' });
} finally {
    await browser.close();
}
console.log(failures ? `${failures} FAILED` : 'ALL PASSED');
process.exit(failures ? 1 : 0);
