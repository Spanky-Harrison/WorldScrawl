// The code the extension shares with the server (plugin/shared/), loaded once at startup from the plugin at
// `<server>/shared/`, where <server> follows the Map server URL setting (empty = SillyTavern's own plugin route).
// index.js cannot be imported here (it imports this file), so the setting is read straight from SillyTavern.
// Under Node (unit tests) the repo's plugin/shared/ next to extension/ is loaded instead.
// If loading fails, every module below is empty, `sharedError` says which URL was tried, and startup shows it.
const NAMES = ['calendar', 'patches', 'doorbar', 'weather', 'prompts', 'npc', 'exits'];
const PLUGIN_URL = '/api/plugins/worldscrawl';

/** The URL shared/ is loaded from, for the current Map server URL setting. */
export function sharedUrl() {
    const u = String(globalThis.SillyTavern?.getContext?.()?.extensionSettings?.worldscrawl?.serverUrl || '').trim();
    return `${!u ? PLUGIN_URL : u.replace(/\/+$/, '')}/shared/`;
}

/** null, or the message to show when shared/ could not be loaded. */
export let sharedError = null;
/** The URL shared/ was loaded from (a later change of the setting reloads the page; see settings.mjs). */
export let sharedLoadedFrom = null;

async function loadShared() {
    const base = globalThis.process?.versions?.node ? new URL('../plugin/shared/', import.meta.url).href : sharedUrl();
    sharedLoadedFrom = base;
    try {
        return Object.fromEntries(await Promise.all(NAMES.map(async n => [n, await import(`${base}${n}.mjs`)])));
    } catch (e) {
        sharedError = `WorldScrawl could not load its shared code from ${base} (${e.message}). Is the WorldScrawl server plugin installed, and SillyTavern restarted since? If the Map server URL setting is filled in, check it.`;
        console.error('[WorldScrawl]', sharedError);
        return Object.fromEntries(NAMES.map(n => [n, {}]));
    }
}

const S = await loadShared();
export const { calendar, patches, doorbar, weather, prompts, npc, exits } = S;
// Prompt text helpers, used everywhere in the extension.
export const { render, setPrompts, hasPrompts } = S.prompts;
// NPC record helpers the server uses too (cast files, exports, ids).
export const { exportRecord, freeId, nameIn, normName, resolveSchedulePlace } = S.npc;
export const { revealsDestination } = S.exits;
