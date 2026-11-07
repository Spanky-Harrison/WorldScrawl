// Appearance replay. The pinned baseline is the cast template copied once per person for this chat.
// The lasting result is one ordered replay of committed lasting operations. The live result adds
// surviving temporary owners. Composition keys are those inputs, never the decision counter.
import { effectFields, looksInputKey } from './npceffects.mjs';

export const BASELINE_KEY = 'worldscrawl_npc_baseline';
export const COMPOSE_KEY = 'worldscrawl_compose';
export const MID_KEY = 'worldscrawl_mid';

const hash = s => {
    let h = 5381;
    const t = String(s);
    for (let i = 0; i < t.length; i++) h = Math.imul(h, 33) ^ t.charCodeAt(i);
    return (h >>> 0).toString(36);
};

export function messageKey(msg) {
    if (!msg) return '';
    msg.extra = msg.extra ?? {};
    if (!msg.extra[MID_KEY]) msg.extra[MID_KEY] = `m_${hash(`${Date.now()}:${Math.random()}`)}`;
    return msg.extra[MID_KEY];
}

/** Same word diff as plugin/ui/diffview.mjs. Kept here because the extension and the map are different roots. */
export function wordDiff(oldText, newText) {
    const a = String(oldText ?? '').split(/(\s+)/).filter(Boolean), b = String(newText ?? '').split(/(\s+)/).filter(Boolean), n = a.length, m = b.length, w = m + 1;
    if (n * m > 400_000) return [...(n ? [{ type: 'del', text: a.join('') }] : []), ...(m ? [{ type: 'ins', text: b.join('') }] : [])];
    const t = new Int32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) t[i * w + j] = a[i] === b[j] ? t[(i + 1) * w + j + 1] + 1 : Math.max(t[(i + 1) * w + j], t[i * w + j + 1]);
    const out = [], push = (type, x) => { const last = out.at(-1); if (last?.type === type) last.text += x; else out.push({ type, text: x }); };
    let i = 0, j = 0;
    while (i < n || j < m) {
        if (i < n && j < m && a[i] === b[j]) { push('same', a[i]); i++; j++; }
        else if (i < n && (j >= m || t[(i + 1) * w + j] >= t[i * w + j + 1])) push('del', a[i++]);
        else push('ins', b[j++]);
    }
    return out;
}

/** Paint one field's word diff into `parent`. Read-only. */
export function paintWordDiff(doc, parent, label, before, after) {
    const box = doc.createElement('div');
    box.className = 'worldscrawl_worddiff';
    box.setAttribute('data-field', label);
    const cap = doc.createElement('div');
    cap.className = 'wsdiff-label';
    cap.textContent = label;
    box.append(cap);
    const line = doc.createElement('div');
    line.className = 'wsdiff-text';
    for (const p of wordDiff(before, after)) {
        if (p.type === 'same') line.append(doc.createTextNode(p.text));
        else {
            const s = doc.createElement('span');
            s.className = p.type === 'del' ? 'wsdiff-wdel' : 'wsdiff-wins';
            s.setAttribute('data-mark', p.type === 'del' ? 'Removed' : 'Added');
            s.textContent = p.text;
            line.append(s);
        }
    }
    box.append(line);
    parent.append(box);
    return box;
}

export function contentIdOf(committed, start, lasts) {
    const c = committed ?? {};
    return `c_${hash(JSON.stringify({
        kind: c.kind || '',
        intent: c.intent || '',
        fields: c.fields || '',
        layer: c.layer || null,
        field: c.field || '',
        text: c.text || '',
        start: Number.isFinite(start) ? start : 0,
        lasts: lasts ?? null,
    }))}`;
}

export function fieldKeyOf(baseline, ops) {
    return `fields:${hash(JSON.stringify({
        body: baseline?.body ?? '',
        outfit: baseline?.outfit ?? '',
        ops: (ops ?? []).map(o => o.contentId),
    }))}`;
}

export function isOwnerStamp(s) {
    return !!s && (s.type === 'npc_appearance' || s.type === 'npc_baseline') && s.identity && (s.committed || s.candidate);
}

export function readBaselineMap(chat) {
    const raw = chat?.[0]?.extra?.[BASELINE_KEY];
    return raw && typeof raw === 'object' ? raw : {};
}

/** Copy the cast template the first time this person is replayed. Never overwritten by export. */
export function pinBaseline(chat, id, body, outfit) {
    if (!chat?.[0] || !id) return { body: body ?? '', outfit: outfit ?? '' };
    const msg = chat[0];
    msg.extra = msg.extra ?? {};
    const map = { ...(msg.extra[BASELINE_KEY] ?? {}) };
    if (!map[id]) map[id] = { body: body ?? '', outfit: outfit ?? '' };
    msg.extra[BASELINE_KEY] = map;
    for (const si of msg.swipe_info ?? []) {
        if (!si) continue;
        si.extra = si.extra ?? {};
        const sm = { ...(si.extra[BASELINE_KEY] ?? {}) };
        if (!sm[id]) sm[id] = map[id];
        si.extra[BASELINE_KEY] = sm;
    }
    return map[id];
}

export function composeRecords(chat, swipe) {
    const out = [];
    for (const m of chat ?? []) {
        const block = m?.extra?.[COMPOSE_KEY];
        if (!block || (block.swipe ?? 0) !== (swipe ?? 0)) continue;
        for (const r of block.records ?? []) if (r?.key) out.push(r);
    }
    return out;
}

export function findCompose(records, key) {
    if (!key) return null;
    for (let i = records.length - 1; i >= 0; i--) if (records[i].key === key) return records[i];
    return null;
}

const expired = (op, elapsed) => op.lasts > 0 && Number.isFinite(op.start) && Number.isFinite(elapsed) && elapsed >= op.start + op.lasts * 60;

/** Committed, on, and not expired. Order is the order supplied (message, then stamp). */
export function liveOps(stamps, elapsed) {
    const out = [];
    for (const s of stamps ?? []) {
        if (!isOwnerStamp(s) || !s.committed || s.off === true) continue;
        const lasts = s.lasts ?? null;
        const start = s.start;
        if (expired({ lasts, start }, elapsed)) continue;
        const contentId = s.contentId || contentIdOf(s.committed, start, lasts);
        out.push({ ...s, contentId, lasts, start });
    }
    return out;
}

/**
 * Explicit text can be replayed without a model: each touched field is set by exactly one operation.
 * Overlap, or an intent with no layer text, returns null (unknown combination).
 */
export function explicitResult(baseline, ops) {
    let body = baseline?.body ?? '', outfit = baseline?.outfit ?? '';
    const n = { body: 0, outfit: 0 };
    for (const op of ops ?? []) {
        const c = op.committed ?? {};
        if (c.kind === 'baseline') {
            if (c.field !== 'body' && c.field !== 'outfit') return null;
            n[c.field]++;
            if (c.field === 'body') body = c.text ?? '';
            else outfit = c.text ?? '';
            continue;
        }
        const fields = effectFields(c.fields).filter(f => f === 'body' || f === 'outfit');
        if (!fields.length) return null;
        for (const f of fields) {
            const text = c.layer?.[f];
            if (!text) return null;
            n[f]++;
            if (f === 'body') body = text;
            else outfit = text;
        }
    }
    if (n.body > 1 || n.outfit > 1) return null;
    return { body, outfit };
}

function resultFor(baseline, ops, records) {
    if (!ops.length) return { body: baseline.body ?? '', outfit: baseline.outfit ?? '', how: 'base', unresolved: false, key: fieldKeyOf(baseline, []) };
    const key = fieldKeyOf(baseline, ops);
    const hit = findCompose(records, key);
    if (hit && hit.body != null && hit.outfit != null && hit.inputsKey === key) return { body: hit.body, outfit: hit.outfit, how: 'reuse', unresolved: false, key };
    const explicit = explicitResult(baseline, ops);
    if (explicit) return { ...explicit, how: 'engine', unresolved: false, key };
    return { body: '', outfit: '', how: 'pending', unresolved: true, key };
}

/**
 * Project one person. `owners` are this person's owner stamps in replay order.
 * Displayed body/outfit/looks are the live result. `lasting` is the export text.
 */
export function projectAppearance(person, owners, records, elapsed) {
    const baseline = person.pinned ?? { body: person.body ?? '', outfit: person.outfit ?? '' };
    const castLooks = person.castLooks ?? person.looks ?? '';
    const ops = liveOps(owners, elapsed);
    const lastingOps = ops.filter(o => !(o.lasts > 0));
    const tempOps = ops.filter(o => o.lasts > 0);
    const lasting = resultFor(baseline, lastingOps, records);
    const live = resultFor(baseline, ops, records);
    let looks = '', looksHow = 'pending';
    if (!live.unresolved) {
        const key = looksInputKey(live.body, live.outfit);
        const hit = findCompose(records, key);
        const same = live.body === (baseline.body ?? '') && live.outfit === (baseline.outfit ?? '');
        if (hit && hit.looks && hit.body === live.body && hit.outfit === live.outfit) { looks = hit.looks; looksHow = 'reuse'; }
        else if (same) { looks = castLooks; looksHow = 'base'; }
        else { looks = ''; looksHow = 'pending'; }
    }
    return {
        pinned: { body: baseline.body ?? '', outfit: baseline.outfit ?? '' },
        lasting: { body: lasting.body, outfit: lasting.outfit, unresolved: lasting.unresolved, key: lasting.key },
        live: { body: live.body, outfit: live.outfit, unresolved: live.unresolved, key: live.key, looks, looksHow, looksKey: looksInputKey(live.body, live.outfit) },
    };
}

/** A candidate standing in for its owner, or added, for a preview. Not a committed stamp. */
export function previewOps(committedOps, candidate, ownerId, start) {
    const lasts = candidate?.proposedLasts ?? null;
    const ghost = {
        identity: { owner: ownerId },
        owner: ownerId,
        committed: candidate?.kind === 'baseline'
            ? { kind: 'baseline', field: candidate.field, text: candidate.text ?? '' }
            : { kind: 'appearance', intent: candidate?.intent ?? '', fields: candidate?.fields ?? 'body,outfit', layer: candidate?.layer ?? {} },
        lasts,
        start,
        off: false,
        contentId: contentIdOf(candidate?.kind === 'baseline'
            ? { kind: 'baseline', field: candidate.field, text: candidate.text ?? '' }
            : { kind: 'appearance', intent: candidate?.intent ?? '', fields: candidate?.fields ?? '', layer: candidate?.layer ?? {} }, start, lasts),
    };
    const without = committedOps.filter(o => (o.owner || o.identity?.owner) !== ownerId);
    const lasting = without.filter(o => !(o.lasts > 0));
    const temps = without.filter(o => o.lasts > 0);
    const intoLasting = !(lasts > 0);
    const lastingWith = intoLasting ? [...lasting, ghost] : lasting;
    const liveWith = [...lastingWith, ...temps, ...(intoLasting ? [] : [ghost])];
    return { lastingWith, liveWith, ghost };
}
