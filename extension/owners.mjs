// One dispatcher for NPC decisions. Appearance uses committed + candidate.
// Other types keep their own stamp fields. Composition jobs are not owners.
import { FOUND_KEY } from './npc.mjs';
import { appearanceScope, classifyAppearanceReply, looksInputKey } from './npceffects.mjs';
import { render as P } from './shared.mjs';

async function model() {
    return import('./dig.mjs');
}
import { COMPOSE_KEY, composeRecords, contentIdOf, explicitResult, fieldKeyOf, findCompose, isOwnerStamp, liveOps, messageKey, previewOps, readBaselineMap } from './replay.mjs';

const APPEARANCE_TRIES = 2;
const FILL_TIMEOUT_MS = 45000;
const epochs = new WeakMap();
export function bumpEpoch(msg) {
    if (!msg) return 0;
    const n = (epochs.get(msg) ?? 0) + 1;
    epochs.set(msg, n);
    return n;
}
export const epochOf = msg => epochs.get(msg) ?? 0;

const newToken = () => `t_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;

export function makeOwner({ type = 'npc_appearance', kind = 'appearance', id, intent = '', fields = 'body,outfit', layer = {}, field = '', text = '', lasts = null, start = 0, chatId = '', message = '', swipe = 0, source = '', scope = 'light', why = '' }) {
    const owner = `o_${hash(`${id}|${intent}|${start}|${Math.random()}`)}`;
    return {
        type, kind, id, owner, intent, source, swipe,
        identity: { chat: chatId, message, swipe, domain: kind, npc: id, owner },
        contentId: null, decisionRev: 1, off: false, start, lasts,
        committed: null,
        candidate: {
            token: newToken(), epoch: 0, proposedLasts: lasts, kind, intent, fields, layer, field, text, scope: appearanceScope(scope), why,
            phase: 'working', lastingKey: '', liveKey: '', lastingPreview: null, livePreview: null,
        },
    };
}
function hash(s) {
    let h = 5381;
    const t = String(s);
    for (let i = 0; i < t.length; i++) h = Math.imul(h, 33) ^ t.charCodeAt(i);
    return (h >>> 0).toString(36);
}

export function findStamp(chat, identity) {
    if (!identity?.owner || !identity?.message) return null;
    for (let i = 0; i < (chat?.length ?? 0); i++) {
        const msg = chat[i];
        if (!msg || messageKey(msg) !== identity.message) continue;
        if ((msg.swipe_id ?? 0) !== (identity.swipe ?? 0)) return null;
        const list = msg.extra?.worldscrawl_npc;
        if (!Array.isArray(list)) continue;
        const stamp = list.find(s => s && (s.owner === identity.owner || s.identity?.owner === identity.owner));
        if (stamp) return { msg, index: i, stamp };
    }
    return null;
}

function swipeOk(msg, identity) {
    return (msg.swipe_id ?? 0) === (identity.swipe ?? msg.swipe_id ?? 0);
}

export function policyFor(type) {
    const edit = ['npc_fact', 'npc_memory', 'npc_disposition', 'npc_create', 'npc_found', 'npc_appearance', 'npc_baseline'];
    const approve = ['npc_fact', 'npc_appearance', 'npc_baseline'];
    return {
        approve: approve.includes(type),
        discard: approve.includes(type),
        undo: type !== 'npc_decline' && type !== 'npc_appearance_cache',
        off: type !== 'npc_decline' && type !== 'npc_appearance_cache',
        on: type !== 'npc_decline' && type !== 'npc_appearance_cache',
        edit: edit.includes(type),
        retry: type === 'npc_appearance' || type === 'npc_baseline',
    };
}

function writeCompose(msg, swipe, record) {
    msg.extra = msg.extra ?? {};
    const cur = msg.extra[COMPOSE_KEY];
    const records = (cur && (cur.swipe ?? 0) === swipe && Array.isArray(cur.records)) ? cur.records.slice() : [];
    const i = records.findIndex(r => r.key === record.key && r.npc === record.npc);
    if (i >= 0) records[i] = record; else records.push(record);
    msg.extra[COMPOSE_KEY] = { swipe, records };
}

function jobBlock(msg, swipe) {
    const b = msg.extra?.worldscrawl_appearance;
    if (!b || (b.swipe ?? 0) !== swipe) return [];
    return Array.isArray(b.jobs) ? b.jobs.slice() : [];
}
function setJob(msg, swipe, job) {
    msg.extra = msg.extra ?? {};
    const jobs = jobBlock(msg, swipe).filter(j => !(j.npc === job.npc && j.key === job.key && j.part === job.part));
    jobs.push({ id: job.npc, ...job });
    msg.extra.worldscrawl_appearance = { swipe, jobs };
}
function clearJob(msg, swipe, npc, key, part) {
    const jobs = jobBlock(msg, swipe).filter(j => !(j.npc === npc && j.key === key && j.part === part));
    if (jobs.length) msg.extra.worldscrawl_appearance = { swipe, jobs };
    else delete msg.extra.worldscrawl_appearance;
}
/** A failed job for these exact inputs, on the message swipe that still shows it. */
function exhausted(chat, npc, key, part) {
    for (const m of chat ?? []) {
        const active = m?.swipe_id ?? 0;
        const block = m?.extra?.worldscrawl_appearance;
        if (!block || (block.swipe ?? 0) !== active) continue;
        if ((block.jobs ?? []).some(j => (j.npc === npc || j.id === npc) && j.key === key && j.part === part && j.status === 'failed')) return true;
    }
    return false;
}

async function askFields(name, baseline, ops, timeout) {
    const intents = (ops ?? []).map((o, i) => {
        const c = o.committed ?? {};
        if (c.kind === 'baseline') return `${i + 1}. replace ${c.field} with the player's text: ${c.text}`;
        const layer = c.layer?.body || c.layer?.outfit ? ` text ${JSON.stringify(c.layer)}` : '';
        const how = appearanceScope(c.scope) === 'heavy' ? ' (full rewrite)' : ' (light touch)';
        return `${i + 1}. ${c.intent || 'change'} [${c.fields || 'body,outfit'}]${how}${layer}`;
    }).join('\n') || '(none)';
    const base = `- body: ${baseline.body || '(empty)'}\n- outfit: ${baseline.outfit || '(empty)'}`;
    let last = { kind: 'malformed', reason: 'no answer' };
    for (let attempt = 0; attempt < APPEARANCE_TRIES; attempt++) {
        let raw;
        try {
            const { gen, baseReply } = await model();
            raw = await gen('appearance compose', {
                prompt: P('npc.appearance_rebuild', { name: name || 'them', fields: 'body, outfit', base, intents }),
                systemPrompt: P('npc.appearance_rebuild_system', { reply: baseReply('json') }),
                responseLength: 500,
            }, { retry: attempt > 0, note: false, timeout });
        } catch (e) {
            if (e?.code === 'timeout') { last = { kind: 'timeout', reason: 'the rewrite did not answer in time' }; continue; }
            last = { kind: 'application', reason: e?.message || String(e) }; continue;
        }
        const classified = classifyAppearanceReply(raw, ['body', 'outfit']);
        if (classified.kind !== 'ok') { last = classified; continue; }
        const body = classified.answer?.body;
        const outfit = classified.answer?.outfit;
        if (!body || !outfit) { last = { kind: 'partial', reason: 'the answer did not cover every field' }; continue; }
        return { ok: true, body, outfit };
    }
    return { ok: false, ...last };
}

async function askLooks(name, body, outfit, timeout) {
    let last = { kind: 'malformed', reason: 'no answer' };
    for (let attempt = 0; attempt < APPEARANCE_TRIES; attempt++) {
        let raw;
        try {
            const { gen, baseReply } = await model();
            raw = await gen('looks summary', {
                prompt: P('npc.looks_summary', { name: name || 'them', body: body || '(empty)', outfit: outfit || '(empty)', reply: baseReply('json') }),
                systemPrompt: P('npc.looks_summary_system', { reply: baseReply('json') }),
                responseLength: 120,
            }, { retry: attempt > 0, note: false, timeout });
        } catch (e) {
            if (e?.code === 'timeout') { last = { kind: 'timeout', reason: 'the summary did not answer in time' }; continue; }
            last = { kind: 'application', reason: e?.message || String(e) }; continue;
        }
        const classified = classifyAppearanceReply(raw, ['looks']);
        if (classified.kind !== 'ok' || !classified.answer?.looks) { last = classified.kind === 'ok' ? { kind: 'partial', reason: 'no looks line' } : classified; continue; }
        return { ok: true, looks: classified.answer.looks };
    }
    return { ok: false, ...last };
}

function textOf(baseline, ops, records) {
    if (!ops.length) return { body: baseline.body ?? '', outfit: baseline.outfit ?? '', unresolved: false, key: fieldKeyOf(baseline, []) };
    const key = fieldKeyOf(baseline, ops);
    const hit = findCompose(records, key);
    if (hit && hit.inputsKey === key && hit.body != null && hit.outfit != null) return { body: hit.body, outfit: hit.outfit, unresolved: false, key };
    const explicit = explicitResult(baseline, ops);
    if (explicit) return { ...explicit, unresolved: false, key };
    return { body: '', outfit: '', unresolved: true, key };
}

/**
 * Fill the candidate's read-only previews. Both must be valid before phase is review.
 * A late answer is dropped when the token, epoch, or decision revision moved.
 */
export async function fillCandidate(chat, identity, { baseline, name, elapsed = null, timeout = FILL_TIMEOUT_MS } = {}) {
    const found = findStamp(chat, identity);
    if (!found?.stamp?.candidate) return { ok: false, error: 'no candidate' };
    const stamp = found.stamp;
    const token = stamp.candidate.token;
    const epoch = stamp.candidate.epoch;
    const rev = stamp.decisionRev;
    const start = stamp.start;
    const ordered = personOps(chat, identity.npc);
    const mine = ordered.filter(s => s.committed && s.owner !== stamp.owner);
    const { lastingWith, liveWith } = previewOps(ordered, stamp.candidate, stamp.owner, start, elapsed);
    const base = baseline ?? readBaselineMap(chat)[identity.npc] ?? { body: '', outfit: '' };
    const records = composeRecords(chat);
    const lasting = textOf(base, lastingWith, records);
    const live = textOf(base, liveWith, records);
    let lastingBody = lasting, liveBody = live;
    if (lasting.unresolved) {
        const asked = await askFields(name, base, lastingWith, timeout);
        if (!still(found, token, epoch, rev)) return { ok: false, stale: true };
        if (!asked.ok) return failCandidate(found, 'fields', lasting.key, asked);
        lastingBody = { body: asked.body, outfit: asked.outfit, unresolved: false, key: lasting.key };
    }
    if (live.unresolved) {
        const asked = await askFields(name, base, liveWith, timeout);
        if (!still(found, token, epoch, rev)) return { ok: false, stale: true };
        if (!asked.ok) return failCandidate(found, 'fields', live.key, asked);
        liveBody = { body: asked.body, outfit: asked.outfit, unresolved: false, key: live.key };
    }
    if (!still(found, token, epoch, rev)) return { ok: false, stale: true };
    const committedOnly = liveOps(mine, elapsed);
    const lastingBefore = textOf(base, committedOnly.filter(o => !(o.lasts > 0)), records);
    const liveBefore = textOf(base, committedOnly, records);
    const lasts = stamp.candidate.proposedLasts;
    if (lasts > 0 && Number.isFinite(start) && Number.isFinite(elapsed) && elapsed >= start + lasts * 60) {
        stamp.candidate.phase = 'failed';
        return { ok: false, error: 'expired' };
    }
    stamp.candidate.phase = 'review';
    stamp.candidate.baseline = { body: base.body ?? '', outfit: base.outfit ?? '' };
    stamp.candidate.lastingKey = lastingBody.key;
    stamp.candidate.liveKey = liveBody.key;
    stamp.candidate.lastingPreview = { body: lastingBody.body, outfit: lastingBody.outfit };
    stamp.candidate.livePreview = { body: liveBody.body, outfit: liveBody.outfit };
    stamp.candidate.lastingBefore = { body: lastingBefore.body, outfit: lastingBefore.outfit, unresolved: !!lastingBefore.unresolved };
    stamp.candidate.liveBefore = { body: liveBefore.body, outfit: liveBefore.outfit, unresolved: !!liveBefore.unresolved };
    return { ok: true, lasting: stamp.candidate.lastingPreview, live: stamp.candidate.livePreview };
}

function still(found, token, epoch, rev) {
    const s = found.stamp;
    return s.candidate && s.candidate.token === token && s.candidate.epoch === epoch && s.decisionRev === rev && epochOf(found.msg) === epoch;
}

function failCandidate(found, part, key, asked) {
    found.stamp.candidate.phase = 'failed';
    setJob(found.msg, found.stamp.swipe ?? 0, { npc: found.stamp.id, key, part, status: 'failed', kind: asked.kind || 'malformed', reason: asked.reason || 'the answer was not usable' });
    return { ok: false, error: asked.reason || 'failed' };
}

/** Owners on each message's own active swipe. A later message's swipe does not drop an earlier one. */
function personOps(chat, npc) {
    const out = [];
    for (const m of chat ?? []) {
        const active = m?.swipe_id ?? 0;
        for (const s of m?.extra?.worldscrawl_npc ?? []) {
            if (s && s.id === npc && isOwnerStamp(s) && (s.swipe ?? 0) === active) out.push(s);
        }
    }
    return out;
}

function replayKeys(chat, stamp, candidate, elapsed) {
    const ordered = personOps(chat, stamp.id);
    const { lastingWith, liveWith } = previewOps(ordered, candidate, stamp.owner, stamp.start, elapsed);
    const pin = readBaselineMap(chat)[stamp.id] ?? candidate?.baseline ?? { body: '', outfit: '' };
    const records = composeRecords(chat);
    return { lasting: textOf(pin, lastingWith, records).key, live: textOf(pin, liveWith, records).key };
}

/**
 * The only mutator. Checks identity and decisionRev, then writes before any await.
 * Appearance approve persists the reviewed previews and does not call the model.
 */
export function decideNpc(chat, identity, decisionRev, action, payload = {}) {
    if (!identity?.owner) return { ok: false, error: 'missing owner' };
    const found = findStamp(chat, identity);
    if (!found) return { ok: false, stale: true, error: 'That change is gone.' };
    const { msg, stamp } = found;
        if (identity.chat && stamp.identity?.chat && identity.chat !== stamp.identity.chat) return { ok: false, stale: true };
        if (identity.domain && stamp.identity?.domain && identity.domain !== stamp.identity.domain) return { ok: false, stale: true };
        if (identity.npc && stamp.identity?.npc && identity.npc !== stamp.identity.npc) return { ok: false, stale: true };
        if (!swipeOk(msg, identity)) return { ok: false, stale: true };
    if (stamp.decisionRev !== decisionRev) return { ok: false, stale: true };
    const policy = policyFor(stamp.type);
    if (!policy[action] && action !== 'check') return { ok: false, error: `${action} is not available for ${stamp.type}` };
    if (action === 'approve' && isOwnerStamp(stamp)) {
        let c = stamp.candidate;
        if (!c || c.phase !== 'review' || !c.lastingPreview || !c.livePreview || !c.lastingKey || !c.liveKey) return { ok: false, error: 'not reviewable' };
        if (c.token !== payload.token) return { ok: false, stale: true };
        if (epochOf(msg) !== c.epoch) return { ok: false, stale: true };
        const lasts = c.proposedLasts ?? null;
        if (!Number.isFinite(payload.elapsed)) {
            c.clockError = 'The game clock is not available, so this approval cannot check expiry. Approve again once the clock is loaded.';
            return { ok: false, error: c.clockError };
        }
        delete c.clockError;
        if (lasts > 0 && Number.isFinite(stamp.start) && payload.elapsed >= stamp.start + lasts * 60) {
            return { ok: false, error: 'expired' };
        }
        const now = replayKeys(chat, stamp, c, payload.elapsed);
        if (now.lasting !== c.lastingKey || now.live !== c.liveKey) {
            stamp.decisionRev += 1;
            stamp.candidate = { ...c, phase: 'working', lastingPreview: null, livePreview: null, lastingKey: '', liveKey: '' };
            return { ok: false, stale: true, refill: true };
        }
        if (payload.edited) {
            const ed = editedCandidate(chat, stamp, c, payload.edited, payload.elapsed);
            if (ed.error) return { ok: false, error: ed.error };
            c = ed.candidate;
        }
        stamp.decisionRev += 1;
        stamp.committed = c.kind === 'baseline' || stamp.kind === 'baseline'
            ? { kind: 'baseline', field: c.field, text: c.text ?? '' }
            : { kind: 'appearance', intent: c.intent ?? '', fields: c.fields ?? 'body,outfit', layer: { ...(c.layer ?? {}) }, scope: appearanceScope(c.scope), why: c.why || '', ...(c.edited ? { edited: true } : {}) };
        if (c.edited) stamp.by = 'player';
        stamp.kind = stamp.committed.kind;
        stamp.lasts = lasts;
        stamp.contentId = contentIdOf(stamp.committed, stamp.start, stamp.lasts);
        stamp.candidate = null;
        const swipe = msg.swipe_id ?? stamp.swipe ?? 0;
        writeCompose(msg, swipe, { npc: stamp.id, kind: 'fields', key: c.lastingKey, inputsKey: c.lastingKey, body: c.lastingPreview.body, outfit: c.lastingPreview.outfit });
        if (c.liveKey !== c.lastingKey) writeCompose(msg, swipe, { npc: stamp.id, kind: 'fields', key: c.liveKey, inputsKey: c.liveKey, body: c.livePreview.body, outfit: c.livePreview.outfit });
        clearJob(msg, swipe, stamp.id, c.liveKey, 'fields');
        return { ok: true, rev: stamp.decisionRev, compose: true };
    }
    if (action === 'discard' && isOwnerStamp(stamp)) {
        stamp.decisionRev += 1;
        stamp.candidate = null;
        return { ok: true, rev: stamp.decisionRev };
    }
    if (action === 'undo') {
        stamp.decisionRev += 1;
        if (stamp.type === 'npc_found' && Array.isArray(msg.extra[FOUND_KEY])) {
            msg.extra[FOUND_KEY] = msg.extra[FOUND_KEY].filter(x => !(x && x.id === stamp.id && (x.where ?? '') === (stamp.where ?? '') && (x.swipe ?? 0) === (stamp.swipe ?? 0)));
            if (!msg.extra[FOUND_KEY].length) delete msg.extra[FOUND_KEY];
        }
        msg.extra.worldscrawl_npc = (msg.extra.worldscrawl_npc ?? []).filter(s => s !== stamp);
        if (!msg.extra.worldscrawl_npc.length) delete msg.extra.worldscrawl_npc;
        return { ok: true, removed: true };
    }
    if (action === 'off') {
        stamp.decisionRev += 1;
        stamp.off = true;
        return { ok: true, rev: stamp.decisionRev, off: true };
    }
    if (action === 'on') {
        if (stamp.lasts > 0 && Number.isFinite(stamp.start) && Number.isFinite(payload.elapsed) && payload.elapsed >= stamp.start + stamp.lasts * 60) {
            return { ok: false, error: 'expired' };
        }
        stamp.decisionRev += 1;
        stamp.off = false;
        return { ok: true, rev: stamp.decisionRev, off: false };
    }
    if (action === 'approve' && stamp.pending === true) {
        stamp.decisionRev += 1;
        delete stamp.pending;
        return { ok: true, rev: stamp.decisionRev };
    }
    if (action === 'discard' && stamp.pending === true) {
        stamp.decisionRev += 1;
        msg.extra.worldscrawl_npc = (msg.extra.worldscrawl_npc ?? []).filter(s => s !== stamp);
        if (!msg.extra.worldscrawl_npc.length) delete msg.extra.worldscrawl_npc;
        return { ok: true, removed: true };
    }
    if (action === 'edit') {
        stamp.decisionRev += 1;
        if (isOwnerStamp(stamp) || stamp.type === 'npc_appearance' || stamp.type === 'npc_baseline') {
            const prev = stamp.candidate ?? {};
            stamp.candidate = {
                token: newToken(),
                epoch: epochOf(msg),
                proposedLasts: payload.lasts !== undefined ? payload.lasts : (prev.proposedLasts ?? stamp.lasts ?? null),
                kind: stamp.kind || stamp.committed?.kind || 'appearance',
                intent: payload.intent ?? prev.intent ?? stamp.committed?.intent ?? stamp.intent ?? '',
                fields: payload.fields ?? prev.fields ?? stamp.committed?.fields ?? 'body,outfit',
                layer: payload.layer ?? prev.layer ?? stamp.committed?.layer ?? {},
                scope: appearanceScope(payload.scope ?? prev.scope ?? stamp.committed?.scope),
                why: payload.scope && payload.scope !== (prev.scope ?? stamp.committed?.scope) ? 'set by you' : (prev.why ?? stamp.committed?.why ?? ''),
                field: payload.field ?? prev.field ?? stamp.committed?.field,
                text: payload.text ?? prev.text ?? stamp.committed?.text ?? '',
                phase: 'working',
                lastingKey: '', liveKey: '', lastingPreview: null, livePreview: null,
            };
            return { ok: true, rev: stamp.decisionRev, refill: true };
        }
        if (stamp.type === 'npc_memory' && payload.note) stamp.note = payload.note;
        else if (stamp.type === 'npc_disposition' && payload.reason != null) stamp.reason = payload.reason;
        else if (stamp.type === 'npc_fact' && payload.text) stamp.text = payload.text;
        else if (stamp.type === 'npc_create' && payload.card) {
            for (const k of ['name', 'line', 'looks', 'manner', 'voice', 'body', 'outfit', 'history', 'unknownAs', 'facts']) if (payload.card[k] !== undefined) stamp[k] = payload.card[k];
            if (payload.card.invented?.length) stamp.invented = payload.card.invented; else delete stamp.invented;
        } else if (stamp.type === 'npc_create' && payload.line) stamp.line = payload.line;
        else if (stamp.type === 'npc_found' && payload.place) stamp.place = payload.place;
        return { ok: true, rev: stamp.decisionRev };
    }
    return { ok: false, error: 'unsupported' };
}

/**
 * Approve edited: the player's own Body/Outfit text becomes this change. The text replaces the fields this change
 * alters as an explicit layer, and the reviewed results are the typed text, so approving it needs no model call.
 * `edited` is {lasting: {body, outfit}, live: {body, outfit}}; a temporary change edits only live.
 */
function editedCandidate(chat, stamp, c, edited, elapsed) {
    if (c.kind === 'baseline' || stamp.kind === 'baseline') return { error: 'A base text change is edited as text already.' };
    const temp = c.proposedLasts > 0;
    const pick = (row, fb) => ({ body: String(row?.body ?? fb?.body ?? ''), outfit: String(row?.outfit ?? fb?.outfit ?? '') });
    const sameKey = c.liveKey === c.lastingKey;
    const own = temp ? pick(edited.live, c.livePreview) : pick(edited.lasting, c.lastingPreview);
    const before = temp ? (c.liveBefore ?? {}) : (c.lastingBefore ?? {});
    const touched = ['body', 'outfit'].filter(f => own[f].trim() && own[f].trim() !== String(before[f] ?? '').trim());
    if (!touched.length) return { error: 'The edited text is the same as now. Discard the change instead.' };
    const layer = Object.fromEntries(touched.map(f => [f, own[f].trim()]));
    const next = { ...c, fields: touched.join(','), layer, why: 'text edited by you', edited: true };
    const keys = replayKeys(chat, stamp, next, elapsed);
    const lastingPreview = temp ? { ...c.lastingPreview } : { body: own.body.trim() || String(before.body ?? ''), outfit: own.outfit.trim() || String(before.outfit ?? '') };
    const livePreview = temp ? { body: own.body.trim() || String(before.body ?? ''), outfit: own.outfit.trim() || String(before.outfit ?? '') }
        : keys.live === keys.lasting || sameKey ? { ...lastingPreview } : pick(edited.live, c.livePreview);
    return { candidate: { ...next, lastingKey: keys.lasting, liveKey: keys.live, lastingPreview, livePreview } };
}

/**
 * A candidate whose result is text the player typed, reviewed without a model call: the before values are this
 * person's committed replay, and the typed Body/Outfit go through the same Approve-edited rules (editedCandidate).
 * Used by the expiry notice's Edit and a kept change's Edit (a temporary change's typed text is its live text).
 * Refuses while another temporary change sits on top, so "now" is one text.
 */
export function reviewTyped(chat, identity, typed, { baseline = null, elapsed = null } = {}) {
    const found = findStamp(chat, identity);
    if (!found?.stamp?.candidate) return { ok: false, error: 'no candidate' };
    const stamp = found.stamp;
    const base = baseline ?? readBaselineMap(chat)[identity.npc] ?? { body: '', outfit: '' };
    const records = composeRecords(chat);
    const others = liveOps(personOps(chat, identity.npc).filter(s => s.committed && s.owner !== stamp.owner), elapsed);
    const lastingBefore = textOf(base, others.filter(o => !(o.lasts > 0)), records);
    const liveBefore = textOf(base, others, records);
    if (lastingBefore.unresolved || liveBefore.unresolved) return { ok: false, error: 'How they look now is still being worked out. Try again in a moment.' };
    if (lastingBefore.key !== liveBefore.key) return { ok: false, error: 'Another temporary change is still on them. Edit after it ends.' };
    const now = { body: lastingBefore.body, outfit: lastingBefore.outfit };
    const seeded = { ...stamp.candidate, phase: 'review', baseline: { body: base.body ?? '', outfit: base.outfit ?? '' },
        lastingKey: lastingBefore.key, liveKey: liveBefore.key, lastingPreview: { ...now }, livePreview: { ...now },
        lastingBefore: { ...now, unresolved: false }, liveBefore: { ...now, unresolved: false } };
    const ed = editedCandidate(chat, stamp, seeded, { lasting: typed, live: typed }, elapsed);
    if (ed.error) return { ok: false, error: ed.error };
    stamp.candidate = ed.candidate;
    return { ok: true, candidate: ed.candidate };
}

export function beginCandidate(stamp, msg) {
    stamp.candidate = {
        ...(stamp.candidate ?? {}),
        token: stamp.candidate?.token || newToken(),
        epoch: epochOf(msg),
        phase: 'working',
        proposedLasts: stamp.candidate?.proposedLasts ?? stamp.lasts ?? null,
        lastingPreview: null,
        livePreview: null,
    };
    return stamp;
}

/**
 * After the surviving set changes, store a compose record for an unknown combination.
 * Does not create an owner. A known key is left alone.
 */
export async function recompose(chat, { npc, at = null, baseline, name, elapsed, timeout = FILL_TIMEOUT_MS } = {}) {
    const ops = liveOps(personOps(chat, npc), elapsed);
    const key = fieldKeyOf(baseline, ops);
    const records = composeRecords(chat);
    const known = findCompose(records, key);
    const explicit = explicitResult(baseline, ops);
    const msg = Number.isInteger(at) && chat?.[at] ? chat[at] : chat?.at?.(-1);
    if (!msg) return { ok: false, error: 'no message' };
    const hostSwipe = msg.swipe_id ?? 0;
    if (!ops.length || known?.inputsKey === key || explicit) {
        if (explicit && !known) writeCompose(msg, hostSwipe, { npc, kind: 'fields', key, inputsKey: key, body: explicit.body, outfit: explicit.outfit });
        const body = known?.body ?? explicit?.body ?? baseline.body ?? '';
        const outfit = known?.outfit ?? explicit?.outfit ?? baseline.outfit ?? '';
        if (!(body === (baseline.body ?? '') && outfit === (baseline.outfit ?? ''))) await ensureLooks(chat, msg, hostSwipe, npc, name, body, outfit, timeout, baseline, elapsed);
        return { ok: true, key, called: false, msg };
    }
    if (exhausted(chat, npc, key, 'fields')) return { ok: false, key, error: 'failed', skipped: true, msg };
    const asked = await askFields(name, baseline, ops, timeout);
    if (!asked.ok) {
        setJob(msg, hostSwipe, { npc, key, part: 'fields', status: 'failed', kind: asked.kind || 'malformed', reason: asked.reason || 'the answer was not usable' });
        return { ok: false, key, error: asked.reason, msg };
    }
    writeCompose(msg, hostSwipe, { npc, kind: 'fields', key, inputsKey: key, body: asked.body, outfit: asked.outfit });
    clearJob(msg, hostSwipe, npc, key, 'fields');
    await ensureLooks(chat, msg, hostSwipe, npc, name, asked.body, asked.outfit, timeout, baseline, elapsed);
    return { ok: true, key, called: true, msg };
}

async function ensureLooks(chat, msg, swipe, npc, name, body, outfit, timeout, baseline, elapsed) {
    const key = looksInputKey(body, outfit);
    const hit = findCompose(composeRecords(chat), key);
    if (hit && hit.body === body && hit.outfit === outfit && hit.looks) return;
    if (exhausted(chat, npc, key, 'looks')) return;
    const asked = await askLooks(name, body, outfit, timeout);
    const ops = liveOps(personOps(chat, npc), elapsed);
    const now = explicitResult(baseline, ops) || findCompose(composeRecords(chat), fieldKeyOf(baseline, ops));
    if (!now || now.body !== body || now.outfit !== outfit) return;
    if (!asked.ok) {
        setJob(msg, swipe, { npc, key, part: 'looks', status: 'failed', kind: asked.kind || 'malformed', reason: asked.reason || 'no looks line' });
        return;
    }
    writeCompose(msg, swipe, { npc, kind: 'looks', key, inputsKey: key, body, outfit, looks: asked.looks });
    clearJob(msg, swipe, npc, key, 'looks');
}

export { personOps, askFields, askLooks };
