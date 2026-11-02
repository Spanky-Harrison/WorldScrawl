// Prompt snapshot: a fixed scripted chat (a move, a wait, a found, a remember, a lore request) in a real SillyTavern,
// capturing the exact messages sent to the model on every call, diffed against tests/e2e/prompts.golden.json.
// Run: E2E_SCRIPT=snapshot.mjs tests/e2e/run.sh   (UPDATE_SNAPSHOT=1 rewrites the golden file)
import fs from 'node:fs';
import { chromium } from 'playwright-core';
const BASE = `http://localhost:${process.env.E2E_PORT || 8767}/`;
const FAKE = `http://127.0.0.1:${process.env.E2E_FAKE_PORT || 9098}`;
const GOLDEN = new URL('./prompts.golden.json', import.meta.url);
const queue = q => fetch(`${FAKE}/__queue`, { method: 'POST', body: JSON.stringify(q) });
const reqs = async () => (await fetch(`${FAKE}/__requests`)).json();
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'], headless: true });
let code = 0;
try {
    const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
    await page.goto(BASE);
    await page.waitForSelector('#send_textarea', { timeout: 90000 });
    const ok = page.locator('dialog[open] .popup-button-ok').first();
    try { await ok.waitFor({ timeout: 8000 }); await ok.click(); } catch {}
    await page.waitForSelector('input[name="worldscrawl_mode"]', { state: 'attached', timeout: 60000 });
    await page.evaluate(() => { const b = document.getElementById('worldscrawl_enable_new'); b.checked = true; b.dispatchEvent(new Event('change')); });
    await page.evaluate(async fake => {
        const $ = window.jQuery;
        $('#main_api').val('openai').trigger('change');
        $('#chat_completion_source').val('custom').trigger('change');
        $('#custom_api_url_text').val(fake + '/v1').trigger('input');
        $('#custom_model_id').val('fake-model').trigger('input');
        $('#stream_toggle').prop('checked', false).trigger('input');
    }, FAKE);
    await page.evaluate(() => jQuery('#api_button_openai').trigger('click'));
    await page.waitForTimeout(3000);
    await page.evaluate(async () => { const o = await import('/scripts/openai.js'); o.oai_settings.stream_openai = false; });
    await page.evaluate(async () => { await SillyTavern.getContext().selectCharacterById(0); });
    await page.waitForTimeout(2500);
    /** Wait until the model call count stops changing and nothing is generating. */
    const settle = async () => {
        let n = -1;
        for (let i = 0; i < 40; i++) { await page.waitForTimeout(750); const m = (await reqs()).length; if (m === n && await page.evaluate(() => !jQuery('#mes_stop').is(':visible'))) break; n = m; }
    };
    const send = async (text, answers) => { await queue(answers); await page.fill('#send_textarea', text); await page.click('#send_but'); await settle(); };
    const slash = async (cmd, answers = []) => { await queue(answers); await page.evaluate(c => SillyTavern.getContext().executeSlashCommandsWithOptions(c), cmd); await settle(); };
    const steps = [];
    const mark = async name => steps.push({ name, upTo: (await reqs()).length });

    await send('[look] around', [{ content: 'You are in the common room of the Drowned Rat.' }]); await mark('look');
    await send('[move] out', [{ content: 'You step into the square.' }]); await mark('move');
    await send('[move] in', [{ content: 'You step back inside.' }]); await mark('move back');
    await send('I sit and wait for a while.', [{ content: 'stay' }, { content: 'You nurse a drink. [ws_wait: 45m | waiting by the fire]' }]);
    await page.evaluate(() => { const card = [...document.querySelectorAll('.worldscrawl_waitcard')].pop(); [...(card?.querySelectorAll('.menu_button, button, div') ?? [])].find(x => x.textContent.trim() === 'Approve')?.click(); });
    await settle(); await mark('wait');
    await send('I look for the barkeep.', [{ content: 'stay' }, { content: 'Hesk comes out of the back. [ws_flag: found | Hesk]' }]); await mark('found');
    await send('I nod to her.', [{ content: 'stay' }, { content: 'She nods back.' }]); await mark('after found');
    await slash('/ws-npc Corwin', [{ content: '{"name":"Corwin","personality":{"summary":"A ferry hand."}}' }]);
    await page.locator('.worldscrawl_remembercard .worldscrawl_card_btn', { hasText: /^Approve$/ }).last().click().catch(() => {});
    await settle(); await mark('remember');
    await send('[lore] The Drowned Rat', [{ content: 'You recall its history.' }]); await mark('lore');

    const all = await reqs();
    let from = 0;
    const out = steps.map(s => { const calls = all.slice(from, s.upTo).map(r => r.messages); from = s.upTo; return { step: s.name, calls }; });
    const text = JSON.stringify(out, null, 1) + '\n';
    if (process.env.UPDATE_SNAPSHOT || !fs.existsSync(GOLDEN)) { fs.writeFileSync(GOLDEN, text); console.log(`PASS: prompt snapshot written (${all.length} calls)`); }
    else if (fs.readFileSync(GOLDEN, 'utf8') === text) console.log(`PASS: prompt snapshot matches (${all.length} calls)`);
    else {
        fs.writeFileSync(GOLDEN.pathname + '.actual', text);
        const a = fs.readFileSync(GOLDEN, 'utf8').split('\n'), b = text.split('\n'), i = a.findIndex((l, k) => l !== b[k]);
        console.log(`FAIL: prompt snapshot differs at line ${i + 1}\n- ${a[i]}\n+ ${b[i]}\n(full output in prompts.golden.json.actual)`); code = 1;
    }
} catch (e) { console.log('FAIL: snapshot run crashed', e); code = 1; }
finally { await browser.close(); }
process.exit(code);
