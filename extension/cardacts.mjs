// The card action layer: one table of handlers per card type, and the stale check every async action passes through.
// A card's ticket is taken when the card is drawn (what the player saw); an async action (again, scope, rewrite,
// approve, save) without one is refused, and a ticket that no longer matches writes nothing. Handlers re-check the
// ticket after their own awaits where the engine call below them does not already (carriers' flag tickets, the person
// candidate's token/epoch/revision).
import { once } from './notices.mjs';
import { editLib } from './cardlib.mjs';
import { NPC_KEY, npcAt } from './npc.mjs';
import { FLAG_KEY, broadcastMapState, ctx, hooks } from './index.js';
import { analyzeFlag, swapRewrite } from './carriers.mjs';
import { renderPatchCards } from './waits.mjs';
import { discardFlag, keepFlag, syncSwipeExtra, unmergeFlag } from './discovery.mjs';
import { openEditor, openForms } from './patches.mjs';
import { getStoredLocation } from './doors.mjs';
import { applyFacts, castPack, npcClock, settleNpc } from './scene.mjs';
import { decideNpc, fillCandidate } from './owners.mjs';

/** Actions that ask the model or write a decision: each must carry its card's ticket. */
export const ASYNC_ACTIONS = new Set(['again', 'scope', 'rewrite', 'approve', 'save']);
const swipeOf = m => m?.swipe_id ?? 0;
const E = () => editLib();

/** What makes each type's card current. ctx: what the card was drawn from. */
const TICKETS = {
    place({ id }) {
        const msg = ctx().chat?.[id], f = msg?.extra?.[FLAG_KEY], swipe = swipeOf(msg);
        return { type: 'place', id, msg, f, key: `${id}|flag`, still: () => ctx().chat?.[id] === msg && msg?.extra?.[FLAG_KEY] === f && !!f && swipeOf(msg) === swipe && f.status !== 'kept' && f.status !== 'discarded' };
    },
    person({ msg, s, who }) {
        const rev = s.decisionRev ?? 1, token = s.candidate?.token ?? null, swipe = swipeOf(msg);
        return { type: 'person', msg, s, who, rev, token, identity: s.identity, key: `${s.identity?.owner}|npcedit`,
            still: () => (msg.extra?.[NPC_KEY] ?? []).includes(s) && (s.decisionRev ?? 1) === rev && swipeOf(msg) === swipe && (s.candidate?.token ?? null) === token };
    },
};
/** The ticket for a card of `type`, taken as it is drawn. */
export function ticketFor(type, c) { return TICKETS[type]?.(c) ?? null; }

/** A hand edit in an open editor that a scope switch would drop: changed boxes, or a changed map form. */
export function handEdited(key, form = null) {
    const typed = E()?.dirtyFields?.(key)?.length > 0;
    const ops = !!form && form.startOps != null && JSON.stringify(form.getOps()) !== form.startOps;
    return typed || ops;
}

// ---- place (area flag) cards
async function switchRewrite(t, to) {
    const { id, key } = t, form = openForms.get(key);
    if (handEdited(key, form) && !(await hooks.confirm(`Switch to ${to === 'full' ? 'a full rewrite' : 'a light touch'}? It rewrites the suggested change's text and drops the edits you made in the editor.`))) return 'cancelled';
    openForms.delete(key); E()?.closeCardEditor(key);
    return once(`flag-rewrite:${id}`, () => swapRewrite(id, to));
}
const closePlace = t => { openForms.delete(t.key); E()?.closeCardEditor(t.key); };
const place = {
    again: t => once(`flag-retry:${t.id}`, () => { closePlace(t); return analyzeFlag(t.id); }),
    edit: t => openEditor(t.key, t.f.proposal.ops, { loc: Object.keys(t.f.proposal.before ?? {})[0] ?? getStoredLocation() ?? '' }),
    close: t => { closePlace(t); renderPatchCards(); },
    scope: (t, a) => switchRewrite(t, a.to),
    'extra:newroom': t => unmergeFlag(t.id),
    rewrite: t => { const note = String(E()?.editorValues(t.key).intent ?? '').trim(); closePlace(t); return once(`flag-retry:${t.id}`, () => analyzeFlag(t.id, { note })); },
    approve: async t => { await keepFlag(t.id); if (t.f.status === 'kept') E()?.closeCardEditor(t.key); },
    discard: t => { closePlace(t); return discardFlag(t.id); },
};

// ---- person (appearance) cards
const chat = () => ctx().chat ?? [];
async function personDone(msg, facts = false) { syncSwipeExtra(msg); await ctx().saveChat?.(); if (facts) await applyFacts(); renderPatchCards(); broadcastMapState(); }
/** Check again, the scope switch and Rewrite with this: the same change asked again (edit, then a refill). */
const askAgain = (t, key, over = {}) => once(`${key}:${t.identity?.owner}`, async () => {
    const s = t.s, now = chat();
    const elapsed = npcClock(now, Math.max(0, now.length - 1)).elapsed;
    const edited = decideNpc(now, t.identity, t.rev, 'edit', { intent: s.candidate?.intent, layer: s.candidate?.layer, fields: s.candidate?.fields, lasts: s.candidate?.proposedLasts, scope: s.candidate?.scope, ...over });
    if (edited?.refill) await fillCandidate(now, t.identity, { baseline: npcAt(now, now.length - 1, castPack()?.npcs ?? [], s.id)?.pinned, name: t.who, elapsed });
    await personDone(t.msg);
});
const person = {
    again: t => askAgain(t, 'own-re'),
    edit: t => { E()?.openCardEditor(t.key); renderPatchCards(); },
    close: t => { E()?.closeCardEditor(t.key); renderPatchCards(); },
    scope: (t, a) => askAgain(t, 'own-scope', { scope: a.to }),
    rewrite: t => { const intent = String(E()?.editorValues(t.key).intent ?? '').trim() || t.s.candidate?.intent; E()?.closeCardEditor(t.key); return askAgain(t, 'own-edit', { intent }); },
    approve: t => once(`own-ok:${t.identity?.owner}`, async () => {
        const open = E()?.editorOpen(t.key);
        let edited = null;
        if (open) {
            const v = E().editorValues(t.key).fields;
            edited = { lasting: {}, live: {} };
            for (const [k, val] of Object.entries(v)) { const [part, field] = k.split('.'); if (edited[part]) edited[part][field] = val; }
        }
        const res = await settleNpc(chat(), t.identity, t.rev, 'approve', { token: t.token, ...(edited ? { edited } : {}) });
        if (res?.ok) E()?.closeCardEditor(t.key);
        else if (res?.error && edited) toastr.warning(`WorldScrawl: ${res.error}`);
        await personDone(t.msg, true);
        return res;
    }),
    discard: t => once(`own-no:${t.identity?.owner}`, async () => {
        E()?.closeCardEditor(t.key);
        await settleNpc(chat(), t.identity, t.rev, 'discard', {});
        await personDone(t.msg, true);
    }),
};

/** The handlers: the only per-type card code that acts. */
export const HANDLERS = { place, person };

/**
 * Run a card action. Refuses an action the type does not have, an async action without a ticket, and any action whose
 * ticket went stale since the card was drawn (it writes nothing and returns {stale: true}).
 */
export async function runCardAction(type, id, ticket, action = {}) {
    const h = HANDLERS[type]?.[id];
    if (!h) return { ok: false, error: `${id} is not an action of ${type} cards` };
    if (ASYNC_ACTIONS.has(id) && typeof ticket?.still !== 'function') return { ok: false, error: 'no ticket' };
    if (ticket?.still && !ticket.still()) { renderPatchCards(); return { ok: false, stale: true }; }
    return h(ticket, action);
}
