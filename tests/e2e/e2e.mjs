// Run-all for the end-to-end test. The checks live in parts/NN-topic.part: chapters of ONE browser session,
// run in order and sharing its variables (00-setup opens SillyTavern, 99-teardown closes it), so a part is not
// a module on its own. This file joins them into .assembled.mjs (next to it, so playwright-core resolves) and runs it.
import fs from 'node:fs';
const here = new URL('./', import.meta.url);
const parts = fs.readdirSync(new URL('parts/', here)).filter(f => f.endsWith('.part')).sort();
const out = new URL('.assembled.mjs', here);
// Each part sets globalThis.__wsPart first, so a crash names the part it happened in (a crash is not a list of FAILs:
// every part after it never ran).
fs.writeFileSync(out, parts.map((f, i) => (i ? `globalThis.__wsPart = ${JSON.stringify(f.replace(/\.part$/, ''))};\n` : '') + fs.readFileSync(new URL('parts/' + f, here), 'utf8')).join(''));
globalThis.__wsPart = parts[0]?.replace(/\.part$/, '');
try {
    await import(out.href);
} catch (e) {
    const i = parts.findIndex(f => f.replace(/\.part$/, '') === globalThis.__wsPart);
    console.log(`CRASHED after part ${i > 0 ? parts[i - 1].replace(/\.part$/, '') : '(none)'}, in ${globalThis.__wsPart}: ${e?.message ?? e}`);
    console.log(e?.stack ?? '');
    process.exit(2);
}
