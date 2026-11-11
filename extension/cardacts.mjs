// The card action layer: one table of handlers per card type, and the stale check every async action passes through.
// A card's ticket is taken when the card is drawn (what the player saw); an async action (again, scope, rewrite,
// approve, save) without one is refused, and a ticket that no longer matches writes nothing. Handlers re-check the
// ticket after their own awaits where the engine call below them does not already (carriers' flag tickets, the person
// candidate's token/epoch/revision).
import { once } from './notices.mjs';
import { editLib } from './cardlib.mjs';
import { NPC_KEY, foundEditOk, npcAt } from './npc.mjs';
import { normName } from './shared.mjs';
import { decideNpc } from './owners.mjs';
import { currentLocation } from './doors.mjs';
import { FLAG_KEY, PATCH_KEY, broadcastMapState, ctx, hooks } from './index.js';
import { analyzeFlag, isCarrier, removeFromCard, swapRewrite } from './carriers.mjs';
import { renderPatchCards } from './waits.mjs';
import { discardFlag, keepFlag, syncSwipeExtra, undoFlag, unmergeFlag } from './discovery.mjs';
import { isPlaceExpiry, keepExpiryEdit, keptForGood, openEditor, openForms, saveKeptEdit, toggleFromCard } from './patches.mjs';
import { getStoredLocation } from './doors.mjs';
import { REMEMBER_KEY, applyFacts, castPack, npcClock, npcEnv, refreshLivePlaces, discardRemember, editExpiryRevert, editKeptAppearance, keepRemember, rememberWith, retryRemember, settleNpc } from './scene.mjs';
import { NPC_EXPIRED_KIND } from './npcexpiry.mjs';

/** Actions that ask the model or write a decision: each must carry its card's ticket. */
export const ASYNC_ACTIONS = new Set(['again', 'scope', 'rewrite', 'approve', 'save']);
const swipeOf = m => m?.swipe_id ?? 0;
const E = () => editLib();

const stampTicket = (type, id, msg, s, key) => {
    const swipe = swipeOf(msg), rev = s.decisionRev ?? 1, off = s.off === true, sig = JSON.stringify([s.text, s.note, s.reason, s.line, s.place, s.pending]);
    return { type, id, msg, s, key, rev,
        still: () => ctx().chat?.[id] === msg && (msg.extra?.[NPC_KEY] ?? []).includes(s) && swipeOf(msg) === swipe && (s.decisionRev ?? 1) === rev && (s.off === true) === off && JSON.stringify([s.text, s.note, s.reason, s.line, s.place, s.pending]) === sig };
};
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
    /** A kept map change: current while it is still on its message, same swipe, unedited and on/off as drawn. */
    placeKept({ id, msg, p }) {
        const swipe = swipeOf(msg), sig = JSON.stringify(p.ops ?? []), off = p.off === true;
        return { type: 'placeKept', id, msg, p, key: `${id}|${p.id}`,
            still: () => ctx().chat?.[id] === msg && (msg.extra?.[PATCH_KEY] ?? []).includes(p) && swipeOf(msg) === swipe && JSON.stringify(p.ops ?? []) === sig && (p.off === true) === off };
    },
    /** A person note or a found row: current while the stamp is still on its message, same swipe, same revision and on/off. */
    personNote({ id, msg, s, key }) { return stampTicket('personNote', id, msg, s, key); },
    found({ id, msg, s, key }) { return stampTicket('found', id, msg, s, key); },
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

// ---- kept map changes (Edit opens the same map form + Change: as the review card; no editor tab)
const closeKept = t => { openForms.delete(t.key); E()?.closeCardEditor(t.key); };
const placeKept = {
    edit: t => openEditor(t.key, t.p.ops, { loc: '' }),
    close: t => { closeKept(t); renderPatchCards(); },
    save: t => once(`map-save:${t.key}`, async () => {
        const form = openForms.get(t.key);
        if (!form) return { ok: false };
        const note = String(E()?.editorValues(t.key).intent ?? '').trim();
        const r = await saveKeptEdit(t.id, t.p.id, form, { note: note !== String(t.p.note ?? '') ? note : '', still: t.still });
        if (r?.ok) E()?.closeCardEditor(t.key);
        return r;
    }),
    off: t => once(`map-off:${t.id}:${t.p.id}`, () => toggleFromCard(t.id, t.p.id)),
    on: t => once(`map-on:${t.id}:${t.p.id}`, () => toggleFromCard(t.id, t.p.id)),
    undo: t => once(`map-undo:${t.id}:${t.p.id}`, () => {
        closeKept(t);
        if (isCarrier(t.msg)) return removeFromCard(t.id, t.p.id);
        const f = t.msg.extra?.[FLAG_KEY];
        if (f) f.patch = t.p.id; else t.msg.extra[FLAG_KEY] = { patch: t.p.id };
        return undoFlag(t.id);
    }),
};

// ---- person notes (fact, memory, disposition, a remembered person, automatic rows) and a pending lasting fact
async function noteDone(msg) { syncSwipeExtra(msg); await ctx().saveChat?.(); await applyFacts(); renderPatchCards(); broadcastMapState(); }
const NOTE_KEYS = { npc_fact: 'text', npc_memory: 'note', npc_disposition: 'reason' };
/** off / on / undo through settleNpc (a stamp from before owners has no identity: changed in place). */
const settleNote = (t, action) => once(`npc-${action}:${t.key}`, async () => {
    const s = t.s, msg = t.msg;
    E()?.closeCardEditor(t.key);
    const res = s.identity ? await settleNpc(chat(), s.identity, t.rev, action, { elapsed: npcClock(chat(), Math.max(0, chat().length - 1)).elapsed }) : { ok: false };
    if (!res.ok && !s.identity && action === 'undo') {
        msg.extra[NPC_KEY] = (msg.extra[NPC_KEY] ?? []).filter(x => x !== s);
        if (!msg.extra[NPC_KEY].length) delete msg.extra[NPC_KEY];
    } else if (!res.ok && !s.identity && (action === 'off' || action === 'on')) s.off = action === 'off';
    await noteDone(msg);
    return res;
});
/** The note's typed edit: {payload for decideNpc 'edit'} or {error}. */
function noteEdit(s, v) {
    if (s.type === 'npc_create') {
        const built = rememberWith(s, v.fields, v.dirty);
        if (built.error) return { error: built.error };
        return { payload: { card: built.got } };
    }
    const k = NOTE_KEYS[s.type], text = String(v.fields[k] ?? '').trim();
    if (!k) return { error: 'This note has nothing to edit.' };
    if (!text && s.type !== 'npc_disposition') return { error: 'Type the note, or press Undo to remove it.' };
    return { payload: { [k]: text } };
}
const personNote = {
    edit: t => { E()?.openCardEditor(t.key); renderPatchCards(); },
    close: t => { E()?.closeCardEditor(t.key); renderPatchCards(); },
    save: t => once(`npc-save:${t.key}`, async () => {
        const v = E()?.editorValues(t.key) ?? { fields: {}, dirty: [] };
        if (!v.dirty.length) { E()?.closeCardEditor(t.key); renderPatchCards(); return { ok: true, same: true }; }
        const ed = noteEdit(t.s, v);
        if (ed.error) { toastr.warning(`WorldScrawl: ${ed.error}`); return { ok: false, error: ed.error }; }
        const res = t.s.identity ? decideNpc(chat(), t.s.identity, t.rev, 'edit', ed.payload) : applyNote(t.s, ed.payload);
        if (res?.ok) E()?.closeCardEditor(t.key);
        await noteDone(t.msg);
        return res;
    }),
    // A pending lasting fact: Approve (edited) adds it for good with the words in the box; Discard drops it.
    approve: t => once(`npc-ok:${t.key}`, async () => {
        const s = t.s;
        if (E()?.editorOpen(t.key)) {
            const v = E().editorValues(t.key), k = NOTE_KEYS[s.type] ?? 'text', text = String(v.fields[k] ?? '').trim();
            if (text) s[k] = text;
            E().closeCardEditor(t.key);
        }
        delete s.pending;
        s.decisionRev = (s.decisionRev ?? 1) + 1;
        await noteDone(t.msg);
        return { ok: true };
    }),
    discard: t => once(`npc-no:${t.key}`, async () => {
        E()?.closeCardEditor(t.key);
        t.msg.extra[NPC_KEY] = (t.msg.extra[NPC_KEY] ?? []).filter(x => x !== t.s);
        if (!t.msg.extra[NPC_KEY].length) delete t.msg.extra[NPC_KEY];
        await noteDone(t.msg);
        return { ok: true };
    }),
    off: t => settleNote(t, 'off'),
    on: t => settleNote(t, 'on'),
    undo: t => settleNote(t, 'undo'),
};
/** A stamp from before owners (no identity): the edit is written on it directly. */
function applyNote(s, payload) {
    if (payload.card) Object.assign(s, payload.card);
    else Object.assign(s, payload);
    return { ok: true };
}

// ---- a found row: Edit is the room box (an address, or a room's name on the live map)
const found = {
    edit: t => { E()?.openCardEditor(t.key); renderPatchCards(); },
    close: t => { E()?.closeCardEditor(t.key); renderPatchCards(); },
    save: t => once(`found-save:${t.key}`, async () => {
        const s = t.s, typed = String(E()?.editorValues(t.key).fields.place ?? '').trim();
        await refreshLivePlaces();
        const loc = await currentLocation();
        if (!t.still()) { renderPatchCards(); return { ok: false, stale: true }; }
        const env = npcEnv(chat(), loc), n = npcAt(chat(), t.id, castPack()?.npcs ?? [], s.id), pk = castPack();
        const cands = pk?.places?.has(typed) ? [typed] : [...(pk?.places ?? [])].filter(a => normName(pk.labels?.[a] ?? '') === normName(typed));
        const tries = (cands.length ? cands : [typed]).map(a => foundEditOk(n, s.where ?? '', a, env));
        const j = tries.find(x => x.ok) ?? tries[0];
        if (!j.ok) { toastr.warning(`WorldScrawl: ${j.reason}`); return { ok: false, error: j.reason }; }
        const res = s.identity ? decideNpc(chat(), s.identity, t.rev, 'edit', { place: j.place }) : applyNote(s, { place: j.place });
        if (res?.ok) E()?.closeCardEditor(t.key);
        await noteDone(t.msg);
        return res;
    }),
    off: t => settleNote(t, 'off'),
    on: t => settleNote(t, 'on'),
    undo: t => settleNote(t, 'undo'),
};

/** The handlers: the only per-type card code that acts. */
export const HANDLERS = { place, person, expiry, remember, placeKept, personNote, found };

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
