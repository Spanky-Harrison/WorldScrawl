// Light touch / full rewrite for place changes. Pure: no DOM, fetch or model calls (carriers.mjs makes the call).
// `rewrite` ('light' | 'full') says how deeply a proposal rewrites existing prose. It is not change.scope (which rooms).
// It only ever touches text that already exists: room descriptions, area notes, and an existing exit's text.
// Structure (exits, doors, rooms, moves, merges, travel time, settings, names, lasts) and new-room text never change.

/** Shown on the card when the tracker left the choice out: light, without a reason nobody gave. */
export const REWRITE_NOT_JUDGED = 'not judged, so the default';
export const REWRITE_SET_BY_YOU = 'set by you';

const FULL_WORDS = /^\s*(full|heavy|rewrite|re-write|transform|major|big|complete)/i;
const LIGHT_WORDS = /^\s*(light|minor|small|slight|minimal|partial|touch)/i;
/** 'full' for clear full-rewrite words, 'light' for clear light-touch words, else '' (not judged: "medium", "yes", ""). */
export function areaRewrite(v) {
    const t = String(v ?? '');
    return FULL_WORDS.test(t) ? 'full' : LIGHT_WORDS.test(t) ? 'light' : '';
}
/** A why that leads with the pick ("full: the inn burned", "Light touch - one wall"): the word(s) and what separates them. */
const WHY_LEAD = /^\s*(full rewrite|full|heavy|complete|major|light touch|light|minor|slight)\b[\s:;,.\-\u2013\u2014]*/i;
/**
 * The tracker's light touch / full rewrite pick: from `rewrite` when it is a clear word, else from a why that leads with
 * one. A leading word that gives the pick is taken out of the why. {rewrite: 'light'|'full'|'' (not judged), why}.
 */
export function judgeRewrite(rewrite, why) {
    const w = String(why ?? '').trim();
    const r = areaRewrite(rewrite), m = WHY_LEAD.exec(w), lead = m ? areaRewrite(m[1]) : '';
    const rest = m ? w.slice(m[0].length).trim() : w;
    if (r) return { rewrite: r, why: lead === r ? rest : w }; // "full" + "Full: remade" reads "Full rewrite: remade"; a why naming the other pick stays as given
    return lead ? { rewrite: lead, why: rest } : { rewrite: '', why: w };
}

const isObj = v => v != null && typeof v === 'object' && !Array.isArray(v);
const str = v => (typeof v === 'string' ? v.trim() : '');
const lc = v => str(v).toLowerCase();
const FAMILY = { set_description: 'desc', append_description: 'desc', set_lore: 'lore', append_lore: 'lore', update_area: 'lore', set_exit_description: 'exit', set_exit: 'exit' };
const exitOf = (room, dir) => (Array.isArray(room?.exits) ? room.exits.find(e => isObj(e) && lc(e.direction) === lc(dir)) : null) ?? null;

/** The text target an op rewrites ("desc:ADDR", "lore:AREA", "exit:ADDR|direction"), or '' when it rewrites no existing prose. */
export function targetKeyOf(op) {
    if (!isObj(op)) return '';
    const f = FAMILY[op.op];
    if (f === 'desc' && str(op.loc)) return `desc:${str(op.loc)}`;
    if (f === 'lore' && str(op.area)) return op.op === 'update_area' && !str(op.lore) ? '' : `lore:${str(op.area)}`;
    if (f === 'exit' && str(op.loc) && str(op.direction)) return op.op === 'set_exit' && !(isObj(op.fields) && typeof op.fields.description === 'string') ? '' : `exit:${str(op.loc)}|${lc(op.direction)}`;
    return '';
}

/**
 * The texts a scope switch may rewrite: one per existing-prose op of the proposal, with the text before the change and as
 * proposed (from the preview's before/after). A room or area the patch itself creates is new-room text and is left out,
 * and so is a target two ops share (it can't be rewritten without changing which op does what).
 */
export function textTargets(proposal) {
    const ops = Array.isArray(proposal?.ops) ? proposal.ops : [];
    const before = proposal?.before ?? {}, after = proposal?.after ?? {};
    const seen = new Map();
    ops.forEach((op, i) => { const k = targetKeyOf(op); if (k) seen.set(k, [...(seen.get(k) ?? []), i]); });
    const out = [];
    for (const [key, idx] of seen) {
        if (idx.length !== 1) continue;
        const i = idx[0], op = ops[i], fam = FAMILY[op.op];
        let was, now, where, label;
        if (fam === 'desc') {
            const b = before[op.loc], a = after[op.loc];
            if (!isObj(b) || b.area) continue;
            was = str(b.description); now = str(a?.description); where = op.loc; label = `the description of ${b.name ?? op.loc} (${op.loc})`;
        } else if (fam === 'lore') {
            const b = before[op.area], a = after[op.area];
            if (!isObj(b)) continue;
            was = str(b.lore); now = str(a?.lore); where = op.area; label = `the notes of ${b.name ?? op.area} (${op.area})`;
        } else {
            const bx = exitOf(before[op.loc], op.direction);
            if (!bx) continue; // a new exit's text is new text
            was = str(bx.description); now = str(exitOf(after[op.loc], op.direction)?.description); where = op.loc;
            label = `the "${bx.direction}" exit text of ${before[op.loc]?.name ?? op.loc} (${op.loc}), this side only`;
        }
        out.push({ key, i, op: op.op, family: fam, where, direction: fam === 'exit' ? str(op.direction) : '', label, was, now: now || was });
    }
    return out.sort((a, b) => a.i - b.i);
}

/** The op shape the rewrite call answers with for a target. */
export function answerShape(t) {
    if (t.family === 'desc') return `{"op":"set_description","loc":"${t.where}","text":"..."}`;
    if (t.family === 'lore') return `{"op":"set_lore","area":"${t.where}","text":"..."}`;
    return `{"op":"set_exit_description","loc":"${t.where}","direction":"${t.direction}","text":"..."}`;
}
/** The targets as the rewrite question lists them. */
export function targetLines(targets) {
    return targets.map((t, n) => [`${n + 1}. ${t.label}. Answer with ${answerShape(t)}`, `Before the change: ${t.was || '(empty)'}`, `As proposed now: ${t.now || '(empty)'}`].join('\n')).join('\n\n');
}

const TEXT_FIELD = { set_description: 'text', append_description: 'text', set_lore: 'text', append_lore: 'text', update_area: 'lore', set_exit_description: 'text' };
const textOfAnswer = op => (op.op === 'set_exit' ? op.fields?.description : op.op === 'update_area' ? op.lore : op.text);
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** An op with its rewritable text taken out and its family named, so two ops compare on structure only. */
export function structureOf(op) {
    if (!isObj(op)) return op;
    const fam = targetKeyOf(op) ? FAMILY[op.op] : '';
    const o = structuredClone(op);
    if (!fam) return o;
    if (op.op === 'set_exit') { delete o.fields.description; return o; }
    delete o[TEXT_FIELD[op.op]];
    if (fam === 'desc' || (fam === 'lore' && op.op !== 'update_area')) o.op = `${fam}_text`;
    return o;
}
/**
 * The engine guard after a scope switch: the new ops must be the old ones with only their text changed (same ops, order,
 * rooms, areas, exits, names, settings and lasts). Returns '' or what changed.
 */
export function rewriteGuard(oldOps, newOps) {
    const a = Array.isArray(oldOps) ? oldOps : [], b = Array.isArray(newOps) ? newOps : [];
    if (a.length !== b.length) return `it has ${b.length} edit${b.length === 1 ? '' : 's'} instead of ${a.length}`;
    for (let i = 0; i < a.length; i++) {
        if (same(structureOf(a[i]), structureOf(b[i]))) continue;
        const o = a[i] ?? {}, n = b[i] ?? {};
        if (!same(o.lasts, n.lasts)) return `edit ${i + 1} (${o.op}) changed how long it lasts`;
        const where = ['loc', 'area', 'direction', 'to', 'locs', 'into', 'target'].find(k => !same(o[k], n[k]));
        if (where) return `edit ${i + 1} (${o.op}) moved to a different ${where === 'locs' || where === 'loc' || where === 'into' ? 'room' : where}`;
        if (o.op !== n.op) return `edit ${i + 1} became ${n.op} instead of ${o.op}`;
        return `edit ${i + 1} (${o.op}) changed more than its text`;
    }
    return '';
}

/**
 * Put the rewrite call's answer into the proposal's ops: each answer op must name one of `targets` and set only its text.
 * A target left out keeps its text. Returns {ops} or {error}. An appended text comes back whole, as a set_*.
 */
export function mergeRewrite(oldOps, targets, answerOps) {
    const ops = structuredClone(oldOps ?? []);
    const byKey = new Map(targets.map(t => [t.key, t]));
    const done = new Set();
    for (const r of Array.isArray(answerOps) ? answerOps : []) {
        if (!isObj(r)) return { error: 'the answer had something that is not an edit' };
        const key = targetKeyOf(r), t = byKey.get(key);
        if (!key) return { error: `the answer had a ${String(r.op ?? 'non-text')} edit, which a rewrite can't change` };
        if (!t) return { error: `the answer rewrote ${key.replace(/^\w+:/, '')}, which is not one of this change's texts` };
        if (done.has(key)) return { error: `the answer rewrote ${t.where} twice` };
        done.add(key);
        const text = textOfAnswer(r);
        if (typeof text !== 'string' || !text.trim()) return { error: `the answer left ${t.label} empty` };
        const old = ops[t.i];
        // Anything the answer sets besides the text must match the old op (it is copied over, never trusted).
        for (const [k, v] of Object.entries(r)) {
            if (['op', 'text', 'lore', 'fields', 'loc', 'area', 'direction', 'story'].includes(k)) continue;
            if (!same(v, old[k])) return { error: `the answer changed "${k}" on ${t.where}` };
        }
        if (r.op === 'update_area' && str(r.name) && str(r.name) !== str(old.name)) return { error: `the answer renamed ${t.where}` };
        if (r.op === 'set_exit') for (const [k, v] of Object.entries(r.fields ?? {})) if (k !== 'description' && !same(v, old.fields?.[k])) return { error: `the answer changed the exit's "${k}"` };
        const next = String(text).trim();
        if (old.op === 'set_exit') ops[t.i] = { ...old, fields: { ...old.fields, description: next } };
        else if (old.op === 'update_area') ops[t.i] = { ...old, lore: next };
        else if (old.op === 'append_description') ops[t.i] = { ...old, op: 'set_description', text: next };
        else if (old.op === 'append_lore') ops[t.i] = { ...old, op: 'set_lore', text: next };
        else ops[t.i] = { ...old, text: next };
    }
    return { ops, rewritten: [...done] };
}
