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

    await page.waitForSelector('#worldscrawl_use_tools', { state: 'attached', timeout: 60000 });
    const toolNames = () => page.evaluate(() => SillyTavern.getContext().ToolManager.tools.map(t => t.toFunctionOpenAI().function.name));
    check('tools off by default', !(await toolNames()).includes('ws_move'));
    check('no tool nudge by default', await page.evaluate(() => !SillyTavern.getContext().extensionPrompts?.worldscrawl_nudge?.value));
    check('slash commands registered', await page.evaluate(() => { const p = SillyTavern.getContext().SlashCommandParser.commands; return !!p['ws-go'] && !!p['ws-exits']; }));
    // Part 1: the optional tool mode still works.
    await page.evaluate(() => { const c = document.getElementById('worldscrawl_use_tools'); c.checked = true; c.dispatchEvent(new Event('change')); });
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
    await page.evaluate(() => { const c = document.getElementById('worldscrawl_use_tools'); c.checked = false; c.dispatchEvent(new Event('change')); });
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
    check('intent question asked with exit list', intentReq.includes('Which of these exits does the player mean') && intentReq.includes('south') && intentReq.includes('none'), intentReq.slice(0, 200));
    check('intent request has no tools', !JSON.stringify(all[all.length - 2].tools ?? []).includes('ws_move'));
    check('typed movement moved party', (await stored()) === 'riverton:docks', String(await stored()));
    let narr = JSON.stringify((await lastReq()).messages);
    check('narration got arrival facts', narr.includes('The party moved south from Village Square to River Docks') && narr.includes('never move the party'), '');
    check('narration request has no tools', !JSON.stringify((await lastReq()).tools ?? []).includes('ws_move'));
    check('no nudge when tools off', !narr.includes('call ws_look'));

    // Typed non-movement: "none" -> no move, no arrival line.
    await queue([{ content: 'none' }, { content: 'You look at the boats.' }]);
    await send('I look at the boats.', 2);
    check('non-movement keeps location', (await stored()) === 'riverton:docks');
    narr = JSON.stringify((await lastReq()).messages);
    check('no arrival line without a move', !narr.includes('What just happened') && narr.includes('Current location: River Docks'));

    // Invalid answer (not on the list) is treated as none.
    await queue([{ content: 'I think they go to the temple' }, { content: 'Hmm.' }]);
    await send('Maybe the temple?', 2);
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
    await page.evaluate(() => { const c = document.getElementById('worldscrawl_parse_intent'); c.checked = false; c.dispatchEvent(new Event('change')); });
    await queue([{ content: 'You stay.' }]);
    await send('I go south.', 1);
    check('intent off: no move, single request', (await stored()) === 'riverton:temple' && !JSON.stringify((await lastReq()).messages).includes('Which of these exits'));
    await page.screenshot({ path: '/tmp/ws-e2e.png' });
} finally {
    await browser.close();
}
console.log(failures ? `${failures} FAILED` : 'ALL PASSED');
process.exit(failures ? 1 : 0);
