// The shared card and editor (plugin/ui/card.mjs, cardedit.mjs), loaded once at startup from the plugin at <server>/ui/,
// so drawing cards stays synchronous and never flashes. They ship in the same plugin as shared/, so the one version
// check (shared.mjs) covers them; if they can't be loaded at all, WorldScrawl turns off like for any plugin load failure.
import { offReason, sharedUrl, turnOff } from './shared.mjs';

let lib = null, edit = null;
async function load() {
    if (offReason) return;
    const base = globalThis.process?.versions?.node ? new URL('../plugin/ui/', import.meta.url).href : sharedUrl().replace(/shared\/$/, 'ui/');
    try {
        const [c, e] = await Promise.all([import(`${base}card.mjs`), import(`${base}cardedit.mjs`)]);
        lib = c; edit = e;
    } catch (err) { turnOff(`WorldScrawl is off: it could not load its card code from ${base} (${err?.message}). Is the WorldScrawl server plugin installed, and SillyTavern restarted since?`); }
}
await load();

/** The loaded card module (renderCard, cardButton, noticeRow, lockRow, markPending…), or null. */
export const cardLib = () => lib;
/** The loaded editor module (buildCardEditor, editorOpen, editorValues…), or null. */
export const editLib = () => edit;
/** Tests hand in a module pair. */
export function useCardLib(c, e = edit) { lib = c; edit = e; return !!(c && e); }
