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

    await page.waitForFunction(() => window.SillyTavern?.getContext?.()?.ToolManager?.tools?.some(t => t.toFunctionOpenAI().function.name === 'ws_move'), null, { timeout: 60000 }).catch(() => {});
    const tools = await page.evaluate(() => SillyTavern.getContext().ToolManager.tools.map(t => t.toFunctionOpenAI().function.name));
    check('tools registered', tools.includes('ws_look') && tools.includes('ws_move'), JSON.stringify(tools));
    check('settings panel present', await page.locator('#worldscrawl_url').count() === 1);

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
    await page.screenshot({ path: '/tmp/ws-e2e.png' });
} finally {
    await browser.close();
}
console.log(failures ? `${failures} FAILED` : 'ALL PASSED');
process.exit(failures ? 1 : 0);
