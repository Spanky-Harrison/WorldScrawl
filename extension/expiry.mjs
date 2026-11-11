// Moved out of index.js unchanged (see docs/CODEMAP.md).
import { render as P, hasPrompts } from './shared.mjs';
import { PLAYER, LOC_KEY, playerAddress, placeStamp } from './actors.mjs';
import { chatChanges, chatWorld, clockAt, rememberWorlds, worldSeed } from './clock.mjs';
import { registerTools, toolsToRegister } from './discovery.mjs';
import { api, ensurePrompts, getStoredLocation } from './doors.mjs';
import { fetchLocationCached } from './footer.mjs';
import { FLAGHINT_KEY, NUDGE_KEY, TOOL_NAMES, WORLD_KEY, ctx, isOn, settings, syncWorld } from './index.js';
import { displayName, keyFor, optionLines, partyText } from './movement.mjs';
import { revealsDestination } from './shared.mjs';
import { mapCtx, patchSig } from './patches.mjs';

const expiryNarrated = new Set();
const chatKey = () => { try { return String(ctx().getCurrentChatId?.() ?? ''); } catch { return ''; } };
/** The places a run-out room's exits still reach, as pick-one keys (the way they came in first). */
export const expiryOptions = list => { const taken = new Set(); return list.map(o => ({ key: keyFor(o.name ?? o.address, taken), label: `${o.name ?? o.address}${o.direction ? ` (out through the ${o.direction})` : ''}`, address: o.address, direction: o.direction ?? '' })); };
export const expiryPickPrompt = (room, opts, def) => P('narration.expiry_pick', { party: partyText(), place: room.name ?? '', ended: room.change?.ended ?? 'its time ran out', description: room.description ?? '', options: optionLines(opts), default: def ?? opts[0]?.key ?? '' });
/** A short excerpt of the message that made the place (about 240 characters, one line). */
export const excerptOf = text => { const t = String(text ?? '').replace(/\s+/g, ' ').trim(); return t.length > 240 ? `${t.slice(0, 237).replace(/\s+\S*$/, '')}...` : t; };
export function expiryNarrationLine(room, to, via, who, excerpt) {
    const sum = room.change ? [room.change.note, ...(Array.isArray(room.change.summary) ? room.change.summary : [room.change.summary])].filter(Boolean).join('; ') : '';
    return P('narration.expired', { place: room.name ?? '', ended: room.change?.ended ?? 'its time ran out', description: room.description || '(none)', change: sum || '(unknown)', excerpt: excerpt || '(none)', party: who, to: displayName(to), via: via ? ` (out through the ${via})` : '' });
}
async function postExpiredNotice(from, toAddr, via) {
    const c = ctx(), to = await fetchLocationCached(toAddr);
    if (!to) return;
    const msg = { name: 'WorldScrawl', is_user: false, is_system: true, send_date: Date.now(), mes: expiredNotice(to, via),
        extra: { worldscrawl_notice: true, worldscrawl_notice_kind: 'missing', worldscrawl_notice_from: from, worldscrawl_notice_expired: true, [LOC_KEY]: to.address } };
    c.chat.push(msg); c.addOneMessage?.(msg); await c.saveChat?.();
}
/** Index of the last story reply, or -1. System notes and the player's own lines are not story replies. */
function lastStory(chat) {
    for (let i = (chat?.length ?? 0) - 1; i >= 0; i--) { const m = chat[i]; if (m && !m.is_user && !m.is_system) return i; }
    return -1;
}
/** Remember, on the patch, whether it was off at the last story reply. The first toggle after that reply wins;
 *  later toggles do not overwrite it. */
export function rememberToggle(chat, patch, msgIndex, id, wasOff) {
    const L = lastStory(chat);
    if (L < 0 || !patch || patch.narrated?.at === L) return;
    patch.narrated = { at: L, off: !!wasOff };
}
/** The map as the last narrator reply saw it: changes up to it (with later Turn off / Turn on reverted), its clock and room.
 *  The reverted bit lives on the patch (`narrated`).
 *  Limitation: a change undone (removed) after that reply is gone from the chat, so it can't be put back here. */
export function narratedView(chat) {
    const L = lastStory(chat);
    if (L < 0) return null;
    let address = null;
    for (let i = L; i >= 0 && !address; i--) address = playerAddress(chat[i]?.extra?.[LOC_KEY]);
    if (!address) return null;
    const head = chat.slice(0, L + 1);
    const changes = chatChanges(head).map(c => (c.narrated?.at === L ? { ...c, off: !!c.narrated.off } : c));
    return { index: L, address, changes, now: clockAt(L, chat) };
}
/** One-time "what just happened" line when the map changed around the party without narration (expiry, Turn off, Undo). */
async function aftermathNote(chat, loc) {
    const L = lastStory(chat);
    const remembered = L >= 0 && chatChanges(chat).some(c => c?.narrated?.at === L);
    if (!patchSig() && !remembered) return '';
    const then = narratedView(chat);
    if (!then) return '';
    const r = await api('/aftermath', { method: 'POST', body: JSON.stringify({ then, address: loc.address, ...mapCtx() }) }).catch(() => null);
    return r?.ok ? r.body?.note ?? '' : '';
}
/** A temporary change ran out with the party inside: they go back out the way they came in. */
export const expiredNotice = (to, via) => `[Engine: the passage seals behind you. You're back in ${displayName(to)}${via ? ` (out through the ${via})` : ''}.]`;
/** The narrator's one "you're now in X" note: a resolver move not yet followed by a narrated reply. */
export function relocationNote(chat, loc, who) {
    for (let i = (chat?.length ?? 0) - 1; i >= 0; i--) {
        const m = chat[i];
        if (m?.extra?.worldscrawl_notice_kind === 'missing' && m.extra.worldscrawl_notice_expired) return playerAddress(m.extra[LOC_KEY]) === loc?.address ? `Note: the temporary place ${who} was in is gone (its time ran out); the passage sealed behind ${who}, and ${who} is back in ${displayName(loc)}. Narrate this naturally.` : '';
        if (m?.extra?.worldscrawl_notice_kind === 'missing') return playerAddress(m.extra[LOC_KEY]) === loc?.address ? `Note: the place ${who} was in no longer exists in this world. ${who} is now in ${displayName(loc)}. Narrate this naturally as where ${who} finds themself now.` : '';
        if (m && !m.is_system && !m.is_user) return '';
    }
    return '';
}

/** Every chat gets a location from turn one: stamp the start onto the greeting (message 0) if nothing is saved. */
export async function ensureStartStamp() {
    syncWorld();
    const c = ctx();
    const first = c.chat?.[0];
    if (!first || getStoredLocation()) return;
    if (!chatWorld()) { // new chat: built on the world chosen in the settings (default: the server's default world)
        const list = await api('/worlds').catch(() => null);
        rememberWorlds(list?.body);
        const id = settings().world || list?.body?.default;
        const info = list?.body?.worlds?.find(w => w.id === id);
        let seed = null;
        if (info?.has_knowledge) seed = (await api(`/worlds/${encodeURIComponent(info.id)}/knowledge`).catch(() => null))?.body?.knowledge ?? null;
        if (info) { first.extra = first.extra ?? {}; first.extra[WORLD_KEY] = { id: info.id, name: info.name, version: info.map_version, ...(seed ? { seed } : {}) };
            for (const sw of first.swipe_info ?? []) { if (sw) { sw.extra = sw.extra ?? {}; sw.extra[WORLD_KEY] = first.extra[WORLD_KEY]; } } }
        syncWorld();
    }
    const seedLoc = worldSeed()?.location;
    const start = (seedLoc && await fetchLocationCached(seedLoc)) || await fetchLocationCached(null);
    if (!start || c.chat?.[0] !== first || getStoredLocation()) return;
    first.extra = first.extra ?? {};
    first.extra[LOC_KEY] = placeStamp(first.extra[LOC_KEY], PLAYER, start.address);
    // keep it on the greeting's swipes too, so swiping the greeting doesn't drop it
    for (const sw of first.swipe_info ?? []) { if (sw) { sw.extra = sw.extra ?? {}; sw.extra[LOC_KEY] = placeStamp(sw.extra[LOC_KEY], PLAYER, start.address); } }
    await c.saveChat();
}

function describe(loc) {
    return JSON.stringify({
        location: loc.name,
        address: loc.address,
        region: loc.region?.name,
        description: loc.description,
        exits: loc.exits.map(e => ({ direction: e.direction, ...(revealsDestination(e) ? { leads_to: e.to_name } : {}), ...(e.description ? { description: e.description } : {}) })),
    });
}

function applyTools() {
    const c = ctx();
    const want = new Set(toolsToRegister(settings(), isOn()));
    for (const n of TOOL_NAMES) if (!want.has(n)) { try { c.unregisterFunctionTool(n); } catch { /* not registered */ } }
    if (!want.size) return;
    // ws_flag, ws_wait and ws_npc take their descriptions from prompts. Look and move do not.
    const needsPrompts = ['ws_flag', 'ws_wait', 'ws_npc'].some(n => want.has(n));
    if (needsPrompts && !hasPrompts()) { ensurePrompts().then(applyTools).catch(e => console.warn('[WorldScrawl]', e.message)); return; }
    registerTools(want);
}

/** Movement nudge only when the model moves the party. The story prompt does not carry flag or wait instructions. */
function applyNudge() {
    const s = settings();
    const text = s.moveMode === 'tools' && isOn() ? String(s.nudge ?? '').trim() : '';
    ctx().setExtensionPrompt(NUDGE_KEY, text, 1 /* IN_CHAT */, 1, false, 0 /* SYSTEM */);
    if (!hasPrompts()) { ensurePrompts().catch(e => console.warn('[WorldScrawl]', e.message)); return; }
    ctx().setExtensionPrompt(FLAGHINT_KEY, '', 1 /* IN_CHAT */, 1, false, 0 /* SYSTEM */);
}

export { aftermathNote, applyNudge, applyTools, chatKey, describe, expiryNarrated, postExpiredNotice };
