// Run-all for the end-to-end test. The checks live in parts/NN-topic.part: chapters of ONE browser session,
// run in order and sharing its variables (00-setup opens SillyTavern, 99-teardown closes it), so a part is not
// a module on its own. This file joins them into .assembled.mjs (next to it, so playwright-core resolves) and runs it.
import fs from 'node:fs';
const here = new URL('./', import.meta.url);
const parts = fs.readdirSync(new URL('parts/', here)).filter(f => f.endsWith('.part')).sort();
const out = new URL('.assembled.mjs', here);
fs.writeFileSync(out, parts.map(f => fs.readFileSync(new URL('parts/' + f, here), 'utf8')).join(''));
await import(out.href);
