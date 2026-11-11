// The shared card and editor (plugin/ui/card.mjs, cardedit.mjs), loaded once at startup from the plugin at <server>/ui/,
// so drawing cards stays synchronous and never flashes. The plugin's CARD_VERSION must match CARD_API: a missing or
// older plugin gets one visible line where the cards would be (UPDATE_LINE), never the old inline cards.
import { sharedUrl } from './shared.mjs';

/** The card shape this extension draws. Bump with plugin/ui/card.mjs CARD_VERSION. */
export const CARD_API = 1;
export const UPDATE_LINE = 'WorldScrawl: update the plugin, then restart SillyTavern';

let lib = null, edit = null;
/** null, or why the card code is unavailable ('missing' or 'old'). */
export let cardError = null;

function check(c, e) {
    if (!c?.renderCard || !e?.buildCardEditor) { lib = edit = null; cardError = 'missing'; return false; }
    if (c.CARD_VERSION !== CARD_API || e.CARD_VERSION !== CARD_API) { lib = edit = null; cardError = 'old'; return false; }
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

/** The loaded card module (renderCard, cardButton, noticeRow, lockRow, markPending, resolvedText…), or null. */
export const cardLib = () => lib;
/** The loaded editor module (buildCardEditor, editorOpen, editorValues…), or null. */
export const editLib = () => edit;
/** Tests hand in a module pair (or an old one, to see the update line). */
export function useCardLib(c, e = edit) { return check(c, e); }
