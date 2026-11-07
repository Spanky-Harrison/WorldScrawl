// Appearance effects: base Looks/Body/Outfit plus a stack of intents. Current appearance is
// rebuilt from the base and the active set (never peeled back to a previous combined text).
// Cache stamps reuse a prior rebuild for the same effect-set key. Non-overlapping fields
// combine in the engine; overlapping fields need a model rewrite of only those fields.

export const APPEARANCE_FIELDS = ['looks', 'body', 'outfit'];

const FIELD_ALIAS = { looks: 'looks', summary: 'looks', appearance: 'looks', body: 'body', outfit: 'outfit', wearing: 'outfit', all: 'all' };

/** Normalize a fields list. Omit, empty, unknown, or "all" → all three. */
export function effectFields(fields) {
    if (fields == null || fields === '') return APPEARANCE_FIELDS.slice();
    const raw = Array.isArray(fields) ? fields : String(fields).split(/[+,|/]/);
    const out = [];
    for (const r of raw) {
        const k = FIELD_ALIAS[String(r ?? '').trim().toLowerCase()];
        if (k === 'all') return APPEARANCE_FIELDS.slice();
        if (k && !out.includes(k)) out.push(k);
    }
    return out.length ? out : APPEARANCE_FIELDS.slice();
}

/** Stable key for an ordered list of active effects (intent + fields). */
export function effectSetKey(effects) {
    return (effects ?? []).map(e => {
        const f = effectFields(e.fields).join('+');
        return `${String(e.intent ?? '').trim().toLowerCase()}|${f}`;
    }).join('||');
}

const cloneApp = (a = {}) => ({ looks: a.looks ?? '', body: a.body ?? '', outfit: a.outfit ?? '' });

/** Stable key for the Body and Outfit a Looks line was written from. */
export function looksInputKey(body, outfit) {
    const src = `${body ?? ''}\u0000${outfit ?? ''}`;
    let h = 5381;
    for (let i = 0; i < src.length; i++) h = Math.imul(h, 33) ^ src.charCodeAt(i);
    return `looks:${(h >>> 0).toString(36)}`;
}

/** Attach a derived Looks line, or mark it pending. Never present an older summary as the current one. */
function withDerivedLooks(body, outfit, baseLooks, baseBody, baseOutfit, looksPair, caches, field) {
    const looksKey = looksInputKey(body, outfit);
    const hit = caches[looksKey];
    const fresh = hit && hit.looks && hit.body === (body ?? '') && hit.outfit === (outfit ?? '');
    // looksPair is the body+outfit the current base summary belongs to. A body or outfit edit leaves it behind.
    const paired = looksPair || looksInputKey(baseBody, baseOutfit);
    if (!field.needsModel && looksKey === paired) {
        return { ...field, looks: fresh ? hit.looks : (baseLooks ?? ''), body, outfit, looksHow: fresh ? 'reuse' : 'base', looksKey };
    }
    if (fresh && !field.needsModel) return { ...field, looks: hit.looks, body, outfit, looksHow: 'reuse', looksKey };
    // Fields still in flight: the card masks every row, so the previous line can stay in the data.
    if (field.needsModel) return { ...field, looks: baseLooks ?? '', body, outfit, looksHow: 'pending', looksKey };
    return { ...field, looks: '', body, outfit, looksHow: 'pending', looksKey };
}

/**
 * Current appearance from base + active effects + caches.
 * Body and Outfit are authoritative. Looks is a separate summary of those two,
 * reused only when this exact Body and Outfit were summarized before.
 * how: 'base' | 'engine' | 'model' | 'reuse' | 'pending' (the body/outfit rewrite).
 * looksHow: 'base' | 'reuse' | 'pending'.
 */
export function resolveAppearance(base, effects, caches = {}) {
    const b = cloneApp(base);
    const active = (effects ?? []).filter(e => e && String(e.intent ?? '').trim());
    const finish = (body, outfit, field) => withDerivedLooks(body, outfit, b.looks, b.body, b.outfit, base?.looksPair, caches, field);
    if (!active.length) return finish(b.body, b.outfit, { how: 'base', key: '', needsModel: false, modelFields: [] });
    const key = effectSetKey(active);
    const hit = caches[key];
    if (hit && (hit.body != null || hit.outfit != null) && !String(hit.key ?? key).startsWith('looks:')) {
        const body = hit.body != null && hit.body !== '' ? hit.body : b.body;
        const outfit = hit.outfit != null && hit.outfit !== '' ? hit.outfit : b.outfit;
        return finish(body, outfit, { how: 'reuse', key, needsModel: false, modelFields: [] });
    }
    const byField = { looks: [], body: [], outfit: [] };
    for (const e of active) for (const f of effectFields(e.fields)) if (f !== 'looks') byField[f].push(e);
    const overlapping = ['body', 'outfit'].filter(f => byField[f].length > 1);
    if (overlapping.length) return finish(b.body, b.outfit, { how: 'pending', key, needsModel: true, modelFields: overlapping });
    const out = { body: b.body, outfit: b.outfit };
    const missing = [];
    for (const f of ['body', 'outfit']) {
        const list = byField[f];
        if (!list.length) continue;
        const e = list[0];
        const solo = effectSetKey([e]);
        const fromCache = caches[solo];
        if (fromCache && fromCache[f] != null && fromCache[f] !== '') out[f] = fromCache[f];
        else if (e.text && e.text[f] != null && e.text[f] !== '') out[f] = e.text[f];
        else missing.push(f);
    }
    if (missing.length) return finish(out.body, out.outfit, { how: 'pending', key, needsModel: true, modelFields: missing });
    return finish(out.body, out.outfit, { how: 'engine', key, needsModel: false, modelFields: [] });
}

/**
 * Inputs for a rebuild prompt: base fields plus still-active intents that touch them, in start order.
 * Never passes a previous combined description.
 */
export function rebuildInputs(base, effects, fields) {
    const want = effectFields(fields);
    const b = cloneApp(base);
    return {
        fields: want,
        base: Object.fromEntries(want.map(f => [f, b[f] ?? ''])),
        intents: (effects ?? []).filter(e => effectFields(e.fields).some(f => want.includes(f)))
            .map(e => ({ intent: String(e.intent ?? '').trim(), fields: effectFields(e.fields).filter(f => want.includes(f)) })),
    };
}

/** True when `text` is already Known, already in Looks/Body/Outfit, or matches an active effect intent. */
export function alreadyShown(npc, text) {
    const t = String(text ?? '').trim().toLowerCase();
    if (!t || !npc) return false;
    if ((npc.facts ?? []).some(f => String(f).trim().toLowerCase() === t)) return true;
    for (const f of APPEARANCE_FIELDS) {
        const v = String(npc[f] ?? '').trim().toLowerCase();
        if (v && v === t) return true;
    }
    if ((npc.effects ?? []).some(e => String(e.intent ?? '').trim().toLowerCase() === t)) return true;
    if ((npc.temps ?? []).some(x => String(x.text ?? '').trim().toLowerCase() === t)) return true;
    return false;
}

/**
 * Empty, or only "looks" / "appeared" (any case, light punctuation, a short filler in front).
 * A longer note ("soaked from the rain", "walks in soaked") is a real intent.
 */
const JUNK_APPEARANCE = /^(?:(?:a|an|the|her|his|their|its|she|he|they|just|now|only)\s+)*(?:looks?|looking|appear(?:ed|s|ing)?|appearance)$/;
export function junkAppearanceIntent(intent) {
    const t = String(intent ?? '').trim().toLowerCase().replace(/\s+/g, ' ').replace(/^['"`(\[]+/, '').replace(/['"`)\].!,;:]+$/, '').trim();
    return !t || JUNK_APPEARANCE.test(t);
}

const fieldText = (stamp, f) => {
    const direct = stamp?.[f];
    if (typeof direct === 'string' && direct.trim()) return direct.trim();
    const nested = stamp?.text?.[f];
    return typeof nested === 'string' && nested.trim() ? nested.trim() : '';
};

/** True when the stamp carries Looks, Body or Outfit text that is not what is already listed. */
export function appearanceFieldsChanged(npc, stamp) {
    for (const f of APPEARANCE_FIELDS) {
        const next = fieldText(stamp, f);
        if (next && next !== String(npc?.[f] ?? '').trim()) return true;
    }
    return false;
}

/**
 * No-op appearance: the intent says nothing (empty, "looks", "appeared") and no field text changed.
 * A real field change, or any other intent, is not a no-op — including a change that happens on arrival.
 */
export function noopAppearance(npc, stamp) {
    if (!stamp || (stamp.type && stamp.type !== 'npc_appearance')) return false;
    if (!junkAppearanceIntent(stamp.intent)) return false;
    return !appearanceFieldsChanged(npc, stamp);
}

/**
 * What to do with an appearance stamp. 'skip' keeps the already-active guard (quiet).
 * 'reject' is a no-op: do not stamp it and do not rebuild. 'apply' is a real change.
 */
export function judgeAppearance(npc, stamp) {
    if (!stamp || stamp.type !== 'npc_appearance') return 'apply';
    if (alreadyEffect(npc, stamp.intent, stamp.fields)) return 'skip';
    if (noopAppearance(npc, stamp)) return 'reject';
    return 'apply';
}

/** Intent to store. An empty intent with new field text uses that text so the effect is kept. */
export function appearanceIntent(stamp) {
    const intent = String(stamp?.intent ?? '').trim();
    if (intent) return intent.slice(0, 240);
    for (const f of APPEARANCE_FIELDS) {
        const next = fieldText(stamp, f);
        if (next) return next.slice(0, 240);
    }
    return '';
}

/** True when an equivalent appearance effect (same intent + same fields) is already active. */
export function alreadyEffect(npc, intent, fields) {
    const intentKey = String(intent ?? '').trim().toLowerCase();
    if (!intentKey || !npc) return false;
    const want = effectFields(fields).slice().sort().join('+');
    return (npc.effects ?? []).some(e => String(e.intent ?? '').trim().toLowerCase() === intentKey
        && effectFields(e.fields).slice().sort().join('+') === want);
}

/** Parsed model rewrite: only non-empty looks/body/outfit strings. null when unusable. */
export function readAppearanceAnswer(ans) {
    if (!ans || typeof ans !== 'object' || Array.isArray(ans)) return null;
    const out = {};
    for (const f of APPEARANCE_FIELDS) {
        if (typeof ans[f] === 'string' && ans[f].trim()) out[f] = ans[f].trim();
    }
    return Object.keys(out).length ? out : null;
}

/** True when two appearance bases match field-for-field (empty and missing count the same). */
export function sameAppearanceBase(a = {}, b = {}) {
    return APPEARANCE_FIELDS.every(f => String(a[f] ?? '') === String(b[f] ?? ''));
}

/**
 * Plan a rebuild for an NPC whose current appearance needs the model.
 * Returns null when nothing to do, else { id, key, fields, inputs, base }.
 */
export function planAppearanceRebuild(npc) {
    if (!npc?.id) return null;
    const base = npc.base ?? { looks: npc.looks ?? '', body: npc.body ?? '', outfit: npc.outfit ?? '' };
    const effects = npc.effects ?? [];
    const caches = npc.caches ?? {};
    const resolved = resolveAppearance(base, effects, caches);
    if (!resolved.needsModel) return null;
    // Looks is not rewritten here. A later call summarizes the resolved Body and Outfit.
    const fields = resolved.modelFields.filter(f => f === 'body' || f === 'outfit');
    if (!fields.length) return null;
    return {
        id: npc.id,
        key: resolved.key,
        fields,
        inputs: rebuildInputs(base, effects, fields),
        base: cloneApp(base),
    };
}

/**
 * Accept a field answer for an internal compose record. Not a chat stamp.
 * { stale } when the inputs moved, { failed } when unusable, else { record }.
 */
export function acceptAppearanceRebuild(plan, answer, currentNpc) {
    if (!plan?.key || !plan.id) return { failed: true };
    const curBase = currentNpc?.base ?? { looks: currentNpc?.looks ?? '', body: currentNpc?.body ?? '', outfit: currentNpc?.outfit ?? '' };
    const cur = resolveAppearance(curBase, currentNpc?.effects ?? [], currentNpc?.caches ?? {});
    if (cur.key !== plan.key || !sameAppearanceBase(curBase, plan.base)) return { stale: true };
    const got = readAppearanceAnswer(answer);
    if (!got) return { failed: true };
    for (const f of plan.fields) if (!got[f]) return { failed: true };
    return { record: { kind: 'fields', key: plan.key, inputsKey: plan.key, npc: plan.id, body: got.body ?? '', outfit: got.outfit ?? '' } };
}

/**
 * A Looks summary is due when Body and Outfit are already resolved and this pair has no summary.
 * Returns null when nothing to ask, else { id, key, body, outfit }.
 */
export function planLooksSummary(npc) {
    if (!npc?.id) return null;
    const base = npc.base ?? { looks: npc.looks ?? '', body: npc.body ?? '', outfit: npc.outfit ?? '' };
    const resolved = resolveAppearance(base, npc.effects ?? [], npc.caches ?? {});
    if (resolved.needsModel || resolved.looksHow !== 'pending') return null;
    return { id: npc.id, key: resolved.looksKey, body: resolved.body ?? '', outfit: resolved.outfit ?? '' };
}

/** Accept a Looks answer only while Body and Outfit are still the pair it was asked about. */
export function acceptLooksSummary(plan, answer, currentNpc) {
    if (!plan?.key || !plan.id) return { failed: true };
    const base = currentNpc?.base ?? { looks: '', body: '', outfit: '' };
    const cur = resolveAppearance(base, currentNpc?.effects ?? [], currentNpc?.caches ?? {});
    if (cur.looksKey !== plan.key || (cur.body ?? '') !== plan.body || (cur.outfit ?? '') !== plan.outfit) return { stale: true };
    const got = readAppearanceAnswer(answer);
    if (!got?.looks) return { failed: true };
    return { record: { kind: 'looks', key: plan.key, inputsKey: plan.key, npc: plan.id, looks: got.looks, body: plan.body, outfit: plan.outfit } };
}

/** First JSON object in a model answer. `truncated` when a `{` never closes. */
function readFirstJsonObject(text) {
    const t = String(text ?? '').replace(/```(?:json)?/gi, '');
    let sawOpen = false;
    for (let i = t.indexOf('{'); i >= 0; i = t.indexOf('{', i + 1)) {
        sawOpen = true;
        let depth = 0, inStr = false, esc = false, closed = false;
        for (let j = i; j < t.length; j++) {
            const ch = t[j];
            if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
            if (ch === '"') inStr = true;
            else if (ch === '{') depth++;
            else if (ch === '}' && --depth === 0) { closed = true; try { return { value: JSON.parse(t.slice(i, j + 1)), truncated: false }; } catch { break; } }
        }
        if (!closed) return { value: null, truncated: true };
    }
    return { value: null, truncated: false, sawOpen };
}

const REFUSAL_RE = /^(?:i\s+(?:can(?:not|'t)|won(?:not|'t)|am unable|must refuse)|sorry\b|as an ai\b)/i;

/**
 * What a rebuild reply is, before any stamp is written.
 * kind: empty | refusal | truncated | malformed | partial | ok.
 * partial carries the parsed fields but must not be cached.
 */
export function classifyAppearanceReply(raw, fields = []) {
    const text = String(raw ?? '').trim();
    if (!text) return { kind: 'empty', answer: null, reason: 'empty answer' };
    const obj = readFirstJsonObject(text);
    if (obj.truncated) return { kind: 'truncated', answer: null, reason: 'the answer was cut off before the JSON closed' };
    if (!obj.value || typeof obj.value !== 'object' || Array.isArray(obj.value)) {
        if (REFUSAL_RE.test(text)) return { kind: 'refusal', answer: null, reason: 'the model refused' };
        return { kind: 'malformed', answer: null, reason: 'the answer was not JSON' };
    }
    const got = readAppearanceAnswer(obj.value);
    if (!got) return { kind: 'malformed', answer: null, reason: 'the JSON had no appearance text' };
    const need = (fields ?? []).filter(f => APPEARANCE_FIELDS.includes(f));
    const missing = need.filter(f => !got[f]);
    if (missing.length) return { kind: 'partial', answer: got, missing, reason: `missing ${missing.join(', ')}` };
    return { kind: 'ok', answer: got, reason: '' };
}
