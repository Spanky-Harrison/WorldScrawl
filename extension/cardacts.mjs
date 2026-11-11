// The card action layer: one table of handlers per card type, and the stale check every async action passes through.
// A card's ticket is taken when the card is drawn (what the player saw); an async action (again, scope, rewrite,
// approve, save) without one is refused, and a ticket that no longer matches writes nothing. Handlers re-check the
// ticket after their own awaits where the engine call below them does not already (carriers' flag tickets, the person
// candidate's token/epoch/revision).
import { once } from './notices.mjs';
import { editLib } from './cardlib.mjs';
import { NPC_KEY } from './npc.mjs';
import { FLAG_KEY, broadcastMapState, ctx, hooks } from './index.js';
import { analyzeFlag, swapRewrite } from './carriers.mjs';
import { renderPatchCards } from './waits.mjs';
import { discardFlag, keepFlag, syncSwipeExtra, unmergeFlag } from './discovery.mjs';
import { isPlaceExpiry, keepExpiryEdit, keptForGood, openEditor, openForms } from './patches.mjs';
import { getStoredLocation } from './doors.mjs';
import { REMEMBER_KEY, applyFacts, discardRemember, editExpiryRevert, editKeptAppearance, keepRemember, rememberWith, retryRemember, settleNpc } from './scene.mjs';
import { NPC_EXPIRED_KIND } from './npcexpiry.mjs';

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
    /** A Remember card: current while it is the same card, still in review on the same swipe, showing the same proposal. */
    remember({ id, msg, card }) {
        const swipe = swipeOf(msg), proposal = card.proposal ?? null;
        return { type: 'remember', id, msg, card, proposal, key: `${id}|remember`,
            still: () => ctx().chat?.[id] === msg && msg.extra?.[REMEMBER_KEY] === card && card.status === 'review' && swipeOf(msg) === swipe && (card.proposal ?? null) === proposal };
    },
    /** An expiry notice: current while that notice is still at its place in the chat, on the same swipe. */
    expiry({ id, msg, key, kind, person = null, got = null }) {
        const swipe = swipeOf(msg);
        const here = () => ctx().chat?.[id] === msg && swipeOf(msg) === swipe;
        return { type: 'expiry', id, msg, key, kind, person, got,
            still: kind === 'person' ? () => here() && msg.extra?.worldscrawl_notice_kind === NPC_EXPIRED_KIND : () => here() && isPlaceExpiry(msg) };
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
/** Check again, the scope switch and Rewrite with this: the same change asked again, through settleNpc like every
 *  person action (the edit, then a refill from the pinned baseline at the current clock). */
const askAgain = (t, key, over = {}) => once(`${key}:${t.identity?.owner}`, async () => {
    const c = t.s.candidate;
    const res = await settleNpc(chat(), t.identity, t.rev, 'edit', { intent: c?.intent, layer: c?.layer, fields: c?.fields, lasts: c?.proposedLasts, scope: c?.scope, ...over });
    syncSwipeExtra(t.msg);
    return res;
});
/** The person scope switch: hand-typed text in the open editor would be replaced, so ask first (then it goes). */
async function personScope(t, to) {
    if (handEdited(t.key) && !(await hooks.confirm(`Switch to ${to === 'heavy' ? 'a full rewrite' : 'a light touch'}? It rewrites the body and outfit again and drops the text you typed in the editor.`))) return 'cancelled';
    E()?.closeCardEditor(t.key);
    return askAgain(t, 'own-scope', { scope: to });
}
const person = {
    again: t => askAgain(t, 'own-re'),
    edit: t => { E()?.openCardEditor(t.key); renderPatchCards(); },
    close: t => { E()?.closeCardEditor(t.key); renderPatchCards(); },
    scope: (t, a) => personScope(t, a.to),
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
    // A kept change: Approve edited saves the typed Body/Outfit (no model call), or asks again for an edited Change line.
    save: t => once(`own-save:${t.identity?.owner}`, async () => {
        const s = t.s, v = E()?.editorValues(t.key) ?? { intent: '', fields: {}, dirty: [] }, dirty = new Set(v.dirty);
        let res;
        if (s.type === 'npc_baseline' || s.committed?.kind === 'baseline') {
            const field = s.committed?.field || 'body', text = String(v.fields[field] ?? '').trim();
            res = dirty.has(field) && text ? await settleNpc(chat(), t.identity, t.rev, 'edit', { field, text, lasts: s.lasts }) : { ok: false, error: 'Nothing changed. Type in the box, or press Close editor.' };
        } else {
            const typed = Object.fromEntries(['body', 'outfit'].filter(f => dirty.has(f)).map(f => [f, String(v.fields[f] ?? '')]));
            const intent = dirty.has('_intent') ? String(v.intent ?? '').trim() : '';
            res = Object.keys(typed).length ? await editKeptAppearance(chat(), t.identity, t.rev, { intent, typed })
                : intent ? await editKeptAppearance(chat(), t.identity, t.rev, { intent })
                : { ok: false, error: 'Nothing changed. Type in a box, or press Close editor.' };
        }
        if (res?.ok) E()?.closeCardEditor(t.key);
        else if (res?.error) toastr.warning(`WorldScrawl: ${res.error}`);
        await personDone(t.msg, true);
        return res;
    }),
    off: t => once(`npc-off:${t.identity?.owner}`, () => settleNpc(chat(), t.identity, t.rev, 'off', {})),
    on: t => once(`npc-on:${t.identity?.owner}`, () => settleNpc(chat(), t.identity, t.rev, 'on', {})),
    undo: t => once(`npc-undo:${t.identity?.owner}`, () => { E()?.closeCardEditor(t.key); return settleNpc(chat(), t.identity, t.rev, 'undo', {}); }),
};

// ---- expiry notices (a person's or a place's temporary change ran out)
const expiry = {
    edit: t => {
        if (t.kind === 'person') { E()?.openCardEditor(t.key); renderPatchCards(); return; }
        return openEditor(t.key, keptForGood(t.got?.ran), { loc: t.got?.address ?? '' });
    },
    close: t => { openForms.delete(t.key); E()?.closeCardEditor(t.key); renderPatchCards(); },
    save: t => once(`expiry-ok:${t.key}`, async () => {
        const note = String(E()?.editorValues(t.key).intent ?? '').trim();
        if (t.kind === 'place') {
            const res = await keepExpiryEdit(t.id, t.key, note, t.still);
            if (res?.ok) E()?.closeCardEditor(t.key);
            else if (res?.error) toastr.warning(`WorldScrawl: ${res.error}`);
            return res;
        }
        const v = E()?.editorValues(t.key).fields ?? {};
        const res = await editExpiryRevert(chat().indexOf(t.msg), t.person.id, { body: v.body, outfit: v.outfit });
        if (res?.ok) E()?.closeCardEditor(t.key);
        else if (res?.error) toastr.warning(`WorldScrawl: ${res.error}`);
        await personDone(t.msg, true);
        return res;
    }),
};

// ---- the Remember card
const remember = {
    again: t => once(`remember-retry:${t.id}`, async () => { E()?.closeCardEditor(t.key); await retryRemember(t.id); }),
    edit: t => { E()?.openCardEditor(t.key); renderPatchCards(); },
    close: t => { E()?.closeCardEditor(t.key); renderPatchCards(); },
    // Rewrite with this: the Change note, and every field the player typed stays exactly; the model fills only the rest.
    rewrite: t => once(`remember-retry:${t.id}`, async () => {
        const v = E()?.editorValues(t.key) ?? { intent: '', fields: {}, dirty: [] };
        const keep = Object.fromEntries(v.dirty.filter(k => k !== '_intent').map(k => [k, v.fields[k]]));
        E()?.closeCardEditor(t.key);
        await retryRemember(t.id, { hint: String(v.intent ?? '').trim(), keep });
    }),
    approve: async t => {
        if (!E()?.editorOpen(t.key)) return keepRemember(t.id);
        const v = E().editorValues(t.key);
        const built = t.proposal?.got ? rememberWith(t.proposal.got, v.fields, v.dirty) : { error: 'The card is not ready yet.' };
        if (built.error) { toastr.warning(`WorldScrawl: ${built.error}`); return { ok: false, error: built.error }; }
        E().closeCardEditor(t.key);
        return keepRemember(t.id, { card: built.got });
    },
    discard: t => { E()?.closeCardEditor(t.key); return discardRemember(t.id); },
};

/** The handlers: the only per-type card code that acts. */
export const HANDLERS = { place, person, expiry, remember };

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
