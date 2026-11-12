// The shared card and editor (plugin/ui/card.mjs, cardedit.mjs), loaded once at startup from the plugin at <server>/ui/,
// so drawing cards stays synchronous and never flashes. A missing or older plugin (the one version check, shared.mjs
// pluginError) gets one visible line where the cards would be (UPDATE_LINE), never the old inline cards.
import { pluginError, sharedUrl, usePluginVersion as setPluginVersion } from './shared.mjs';

export const UPDATE_LINE = 'WorldScrawl: update the plugin, then restart SillyTavern';

let lib = null, edit = null, loaded = [null, null];
/** null, or why the card code is unavailable ('missing' or 'old'). */
export let cardError = null;

function check(c, e) {
    loaded = [c, e];
    if (pluginError) { lib = edit = null; cardError = pluginError; return false; }
    if (!c?.renderCard || !e?.buildCardEditor) { lib = edit = null; cardError = 'missing'; return false; }
    lib = c; edit = e; cardError = null;
    return true;
}
async function load() {
    const base = globalThis.process?.versions?.node ? new URL('../plugin/ui/', import.meta.url).href : sharedUrl().replace(/shared\/$/, 'ui/');
    try {
        const [c, e] = await Promise.all([import(`${base}card.mjs`), import(`${base}cardedit.mjs`)]);
        if (!check(c, e)) console.error('[WorldScrawl] card code', cardError, base);
    } catch (err) { lib = edit = null; cardError = 'missing'; console.error('[WorldScrawl] card code could not load from', base, err?.message); }
}
await load();

/** The loaded card module (renderCard, cardButton, noticeRow, lockRow, markPending…), or null. */
export const cardLib = () => lib;
/** The loaded editor module (buildCardEditor, editorOpen, editorValues…), or null. */
export const editLib = () => edit;
/** Tests hand in a module pair (or an old one, to see the update line). */
export function useCardLib(c, e = edit) { return check(c, e); }
/** Tests: act as if the plugin said `version` ('missing': not loaded), and check the cards again. */
export function usePluginVersion(version) { setPluginVersion(version); return check(...loaded); }
