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

/**
 * Current appearance from base + active effects + caches.
 * effects: [{intent, fields, text?: {looks,body,outfit}}] in start order.
 * caches: { [key]: {looks,body,outfit, how?} }
 * Returns { looks, body, outfit, how, key, needsModel, modelFields }.
 * how: 'base' | 'engine' | 'model' | 'reuse' | 'pending'
 */
export function resolveAppearance(base, effects, caches = {}) {
    const b = cloneApp(base);
    const active = (effects ?? []).filter(e => e && String(e.intent ?? '').trim());
    if (!active.length) return { ...b, how: 'base', key: '', needsModel: false, modelFields: [] };
    const key = effectSetKey(active);
    const hit = caches[key];
    if (hit && (hit.looks != null || hit.body != null || hit.outfit != null)) {
        return { looks: hit.looks ?? b.looks, body: hit.body ?? b.body, outfit: hit.outfit ?? b.outfit, how: 'reuse', key, needsModel: false, modelFields: [] };
    }
    const byField = { looks: [], body: [], outfit: [] };
    for (const e of active) for (const f of effectFields(e.fields)) byField[f].push(e);
    const overlapping = APPEARANCE_FIELDS.filter(f => byField[f].length > 1);
    if (overlapping.length) {
        return { ...b, how: 'pending', key, needsModel: true, modelFields: overlapping };
    }
    // Non-overlapping: take each field from its one effect (its solo cache, else its own text).
    const out = cloneApp(b);
    const missing = [];
    for (const f of APPEARANCE_FIELDS) {
        const list = byField[f];
        if (!list.length) continue;
        const e = list[0];
        const solo = effectSetKey([e]);
        const fromCache = caches[solo];
        if (fromCache && fromCache[f] != null && fromCache[f] !== '') out[f] = fromCache[f];
        else if (e.text && e.text[f] != null && e.text[f] !== '') out[f] = e.text[f];
        else missing.push(f);
    }
    if (missing.length) return { ...out, how: 'pending', key, needsModel: true, modelFields: missing };
    return { ...out, how: 'engine', key, needsModel: false, modelFields: [] };
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
    return {
        id: npc.id,
        key: resolved.key,
        fields: resolved.modelFields.slice(),
        inputs: rebuildInputs(base, effects, resolved.modelFields),
        base: cloneApp(base),
    };
}

/**
 * Accept a rebuild answer against the live NPC. Returns a cache stamp, or
 * { stale: true } when the active set moved on, or { failed: true } when the answer is unusable.
 */
export function acceptAppearanceRebuild(plan, answer, currentNpc) {
    if (!plan?.key || !plan.id) return { failed: true };
    const curBase = currentNpc?.base ?? { looks: currentNpc?.looks ?? '', body: currentNpc?.body ?? '', outfit: currentNpc?.outfit ?? '' };
    const cur = resolveAppearance(curBase, currentNpc?.effects ?? [], currentNpc?.caches ?? {});
    if (cur.key !== plan.key || !sameAppearanceBase(curBase, plan.base)) return { stale: true };
    const got = readAppearanceAnswer(answer);
    if (!got) return { failed: true };
    // Must cover every field the plan asked for.
    for (const f of plan.fields) if (!got[f]) return { failed: true };
    const stamp = { type: 'npc_appearance_cache', id: plan.id, key: plan.key, how: 'model' };
    for (const f of APPEARANCE_FIELDS) if (got[f]) stamp[f] = got[f];
    return { stamp };
}
