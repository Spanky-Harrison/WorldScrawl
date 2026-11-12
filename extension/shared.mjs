// The code the extension shares with the server (plugin/shared/), loaded once at startup from the plugin at
// `<server>/shared/`, where <server> follows the Map server URL setting (empty = SillyTavern's own plugin route).
// index.js cannot be imported here (it imports this file), so the setting is read straight from SillyTavern.
// Under Node (unit tests) the repo's plugin/shared/ next to extension/ is loaded instead.
// If loading fails, every module below is empty, `sharedError` says which URL was tried, and startup shows it.
// The ONE version check: once, here, on load, the plugin's WORLDSCRAWL_VERSION (plugin/shared/version.mjs) must equal
// the extension's (extension/version.mjs). If not, or if the plugin's code can't be loaded at all, `offReason` is set
// and WorldScrawl turns itself off: index.js shows that one message and starts nothing.
import { WORLDSCRAWL_VERSION } from './version.mjs';
const NAMES = ['calendar', 'patches', 'doorbar', 'weather', 'prompts', 'npc', 'exits', 'ids', 'cards'];
const PLUGIN_URL = '/api/plugins/worldscrawl';

/** The URL shared/ is loaded from, for the current Map server URL setting. */
export function sharedUrl() {
    const u = String(globalThis.SillyTavern?.getContext?.()?.extensionSettings?.worldscrawl?.serverUrl || '').trim();
    return `${!u ? PLUGIN_URL : u.replace(/\/+$/, '')}/shared/`;
}

/** null, or the message to show when shared/ could not be loaded. */
export let sharedError = null;
/** null, or why WorldScrawl is off for this page load (the one message the player sees). Nothing runs while it is set. */
export let offReason = null;
/** Turn WorldScrawl off for this page load with `why` (the first reason wins). */
export function turnOff(why) { offReason = offReason ?? why; console.error('[WorldScrawl]', why); }
/** The version message: the extension and plugin are different releases. */
export const versionMismatch = plugin => `WorldScrawl is off: the extension (version ${WORLDSCRAWL_VERSION}) and the server plugin (version ${plugin ?? 'unknown'}) don't match. Update both to the same release, then restart SillyTavern.`;
/** The URL shared/ was loaded from (a later change of the setting reloads the page; see settings.mjs). */
export let sharedLoadedFrom = null;

async function loadShared() {
    const base = globalThis.process?.versions?.node ? new URL('../plugin/shared/', import.meta.url).href : sharedUrl();
    sharedLoadedFrom = base;
    try {
        const mods = Object.fromEntries(await Promise.all(NAMES.map(async n => [n, await import(`${base}${n}.mjs`)])));
        let version;
        try { version = (await import(`${base}version.mjs`)).WORLDSCRAWL_VERSION; } catch { version = undefined; } // a plugin from before the check
        if (version !== WORLDSCRAWL_VERSION) turnOff(versionMismatch(version));
        return mods;
    } catch (e) {
        sharedError = `WorldScrawl could not load its shared code from ${base} (${e.message}). Is the WorldScrawl server plugin installed, and SillyTavern restarted since? If the Map server URL setting is filled in, check it.`;
        turnOff(sharedError);
        return Object.fromEntries(NAMES.map(n => [n, {}]));
    }
}

const S = await loadShared();
export const { calendar, patches, doorbar, weather, prompts, npc, exits, ids, cards } = S;
// Prompt text helpers, used everywhere in the extension.
export const { render, setPrompts, hasPrompts } = S.prompts;
// NPC record helpers the server uses too (cast files, exports, ids).
export const { exportRecord, authorRecord, freeId, nameIn, normName, resolveSchedulePlace } = S.npc;
export const { revealsDestination } = S.exits;
export const { slug } = S.ids;
