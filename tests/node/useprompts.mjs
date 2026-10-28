// Load plugin/prompts/default.json into the prompt renderers (the browser fetches it from the plugin instead).
import fs from 'node:fs';
import { setPrompts } from '../../plugin/ui/prompts.mjs';
import { setPrompts as setExt } from '../../extension/prompts.mjs';
export const DEFAULT_PROMPTS = JSON.parse(fs.readFileSync(new URL('../../plugin/prompts/default.json', import.meta.url), 'utf8'));
/** All default prompt text in one string, for tests that look for wording. */
export const PROMPT_TEXT = DEFAULT_PROMPTS.prompts.map(e => e.text).join('\n');
setPrompts(DEFAULT_PROMPTS); setExt(DEFAULT_PROMPTS);
