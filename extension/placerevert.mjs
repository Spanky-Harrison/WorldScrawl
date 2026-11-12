// Place texts rebuilt after a temporary change ran out (or was turned off) under a later change still in force: the
// place twin of people's recompose (owners.mjs). arearewrite.mjs finds the texts (revertNeeds) and puts a known result in
// place (chatChanges); this file asks the model for an unknown one. Same compose records, failed-job block, tries and
// timeout as an appearance rebuild; no call when a record already matches or no later change wrote the text.
import { render as P, patches as patchShared } from './shared.mjs';
import { revertBase, writtenText } from './arearewrite.mjs';
import { parseJsonAnswer } from './carriers.mjs';
import { chatChanges, placeRevertNeeds } from './clock.mjs';
import { baseReply } from './dig.mjs';
import { syncSwipeExtra } from './discovery.mjs';
import { api, ensurePrompts, getStoredLocation } from './doors.mjs';
import { exitsCache } from './footer.mjs';
import { ctx, isOn } from './index.js';
import { once } from './notices.mjs';
import { askTried, clearJob, exhausted, setJob, writeCompose } from './owners.mjs';
import { composeRecords, findCompose } from './replay.mjs';
import { renderPatchCards } from './waits.mjs';
import { mapCtx } from './patches.mjs';

/** Same bound as an appearance rebuild. */
export const PLACE_REVERT_TIMEOUT_MS = 45000;
const PART = 'place';
const swipeOf = m => m?.swipe_id ?? 0;
const lc = s => String(s ?? '').toLowerCase();

/** The texts that still need the model now: a need with no record, minus ones that already failed for these inputs. */
export function pendingPlaceRebuilds(chat = ctx().chat ?? []) {
    const changes = chatChanges(chat, { raw: true });
    const records = composeRecords(chat);
    return placeRevertNeeds(changes, chat).filter(n => !findCompose(records, n.key));
}

/** The base text (before the first dropped writer) and a plain label, from the map server. */
async function baseOf(need, changes) {
    const { now } = mapCtx();
    const loc = need.family === 'lore' ? (getStoredLocation() ?? '') : need.where;
    const r = await api('/patch/context', { method: 'POST', body: JSON.stringify({ changes: revertBase(changes, need), now, location: loc, rooms: [need.where] }) });
    if (!r.ok) throw new Error(r.body?.detail?.error ?? r.body?.detail ?? `map server answered ${r.status}`);
    const b = r.body ?? {};
    if (need.family === 'lore') { const a = b.areas?.[need.where]; return { text: a?.lore ?? '', label: `the notes of ${a?.name ?? need.where}` }; }
    const room = b.rooms?.[need.where];
    if (!room) throw new Error(`${need.where} is not on the map before that change`);
    if (need.family === 'desc') return { text: room.description ?? '', label: `the description of ${room.name ?? need.where}` };
    const ex = (room.exits ?? []).find(e => lc(e?.direction) === lc(need.direction));
    return { text: ex?.description ?? '', label: `the "${need.direction}" exit text of ${room.name ?? need.where}` };
}
const noteOf = w => String(w.change?.summary?.[w.oi] || w.change?.note || w.op?.op || 'a change').trim();
const lineOf = (w, n) => `${n ? `${n}. ` : '- '}${noteOf(w)}. It made the text: ${writtenText(w.op) || '(empty)'}`;
/** Light touch unless a change still in force was kept as a full rewrite (the patch remembers the card's pick). */
const rewriteOf = need => (need.active.some(w => w.change?.rewrite === 'full') ? 'full' : 'light');

/** Ask for one text. Returns {ok, text} or {ok: false, kind, reason}. */
async function askRevert(need, base, at, timeout) {
    const rewrite = patchShared.rewritePiece?.(rewriteOf(need)) ?? '';
    return askTried('map rebuild', {
        prompt: P('change.revert', { revert_text: base.label, revert_before: base.text || '(empty)', revert_ended: need.dropped.map(w => lineOf(w)).join('\n') || '(none)', revert_kept: need.active.map((w, i) => lineOf(w, i + 1)).join('\n') }),
        systemPrompt: P('change.revert_system', { reply: baseReply('json'), rewrite, style: P('change.style') }),
        responseLength: 600,
    }, { timeout, note: true, at, timeoutReason: 'the rebuild did not answer in time', read: raw => {
        const a = parseJsonAnswer(raw);
        const text = typeof a?.text === 'string' ? a.text.trim() : '';
        return text ? { ok: true, text } : { kind: 'malformed', reason: 'the answer was not {"text": "..."} JSON' };
    } });
}

/**
 * Rebuild every place text that needs it, storing results and failures on message `msgId` (the turn it happened on).
 * Awaited by the generation interceptor, like the appearance rebuild, so the narrator sees the result; a failure
 * leaves the plain replay in place and a failed job (Check again) on that message.
 */
export async function ensurePlaceRebuilds(msgId, { timeout = PLACE_REVERT_TIMEOUT_MS, only = null } = {}) {
    const c = ctx(), chat = c.chat ?? [], msg = chat[msgId];
    if (!msg || !isOn()) return { called: 0 };
    let needs = pendingPlaceRebuilds(chat);
    if (only) needs = needs.filter(n => n.target === only);
    needs = needs.filter(n => !exhausted(chat, n.target, n.key, PART));
    if (!needs.length) return { called: 0 };
    await ensurePrompts();
    const changes = chatChanges(chat, { raw: true }), swipe = swipeOf(msg);
    let called = 0;
    for (const need of needs) {
        let base;
        try { base = await baseOf(need, changes); } catch (e) {
            setJob(msg, swipe, { npc: need.target, domain: PART, name: need.target, key: need.key, part: PART, status: 'failed', kind: 'application', reason: e?.message || String(e) });
            continue;
        }
        called++;
        const asked = await askRevert(need, base, msgId, timeout);
        if (!asked.ok) {
            setJob(msg, swipe, { npc: need.target, domain: PART, name: base.label, key: need.key, part: PART, status: 'failed', kind: asked.kind || 'malformed', reason: asked.reason || 'the answer was not usable' });
            continue;
        }
        writeCompose(msg, swipe, { npc: need.target, kind: PART, key: need.key, inputsKey: need.key, text: asked.text });
        clearJob(msg, swipe, need.target, need.key, PART);
    }
    syncSwipeExtra(msg);
    exitsCache.clear();
    try { await c.saveChat?.(); } catch (e) { console.warn('[WorldScrawl] save', e?.message || e); }
    renderPatchCards();
    return { called };
}

/** Check again on a failed place rebuild job: drop the failure and ask once more. */
export function retryPlaceRebuild(msgId, target, key) {
    const msg = ctx().chat?.[msgId];
    if (!msg) return Promise.resolve({ ok: false, error: 'That message is gone.' });
    return once(`place-rebuild:${msgId}:${target}:${key || ''}`, async () => {
        clearJob(msg, swipeOf(msg), target, key, PART);
        syncSwipeExtra(msg);
        await ensurePlaceRebuilds(msgId, { only: target });
        const { applyFacts } = await import('./scene.mjs');
        await applyFacts();
        return { ok: true };
    }).then(r => r ?? { ok: false, error: 'Already retrying.' });
}
