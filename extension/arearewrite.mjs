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
 * A text target as words for a card title ("the description of Common Room", "the notes of The Drowned Rat", "the "back"
 * exit text of Common Room"). `labels`: address/area id -> name (the cast panel's place labels). Never the raw id: an
 * unknown place reads "a place" / "an area", and an unknown target "a place text".
 */
export function targetLabel(target, labels = {}) {
    const m = /^(desc|lore|exit):(.+)$/.exec(String(target ?? ''));
    if (!m) return 'a place text';
    const [where, dir] = m[1] === 'exit' ? m[2].split('|') : [m[2], ''];
    const name = str(labels?.[where]);
    if (m[1] === 'desc') return `the description of ${name || 'a place'}`;
    if (m[1] === 'lore') return `the notes of ${name || 'an area'}`;
    return `the ${dir ? `"${dir}" ` : ''}exit text of ${name || 'a place'}`;
}

const COLLAPSE = { set_description: 'set', append_description: 'append', set_lore: 'set', append_lore: 'append', set_exit_description: 'set' };
/**
 * One text edit per target, last wins: a later set_* replaces an earlier set_* or append_* of the same text (and the
 * same "lasts"); an append_* after it folds into it. Two appends with no set fold into the first. Other ops are
 * untouched and keep their order. Returns {ops, merged} (merged: how many ops were folded or dropped).
 */
export function collapseTextOps(ops) {
    const out = [], at = new Map();
    let merged = 0;
    for (const op of Array.isArray(ops) ? ops : []) {
        const kind = isObj(op) ? COLLAPSE[op.op] : null, target = kind ? targetKeyOf(op) : '';
        if (!target) { out.push(op); continue; }
        const key = `${target}|${JSON.stringify(op.lasts ?? null)}`;
        if (!at.has(key)) { at.set(key, out.length); out.push({ ...op }); continue; }
        merged++;
        if (kind === 'set') { out[at.get(key)] = null; at.set(key, out.length); out.push({ ...op }); continue; }
        const prev = out[at.get(key)];
        prev.text = [str(prev.text), str(op.text)].filter(Boolean).join(' ');
    }
    return { ops: out.filter(o => o !== null), merged };
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
        out.push({ key, i, op: op.op, family: fam, where, direction: fam === 'exit' ? str(op.direction) : '', label, was, now: now || was, added: /^append_/.test(op.op) ? str(op.text) : '' });
    }
    return out.sort((a, b) => a.i - b.i);
}

/** A light touch on an appended text asks for the added part only, so the text before it is never lost. */
export const appendOnly = (t, rewrite) => rewrite !== 'full' && /^append_/.test(t.op);
/** The op shape the rewrite call answers with for a target. */
export function answerShape(t, rewrite = 'light') {
    if (appendOnly(t, rewrite)) return t.family === 'desc' ? `{"op":"append_description","loc":"${t.where}","text":"..."}` : `{"op":"append_lore","area":"${t.where}","text":"..."}`;
    if (t.family === 'desc') return `{"op":"set_description","loc":"${t.where}","text":"..."}`;
    if (t.family === 'lore') return `{"op":"set_lore","area":"${t.where}","text":"..."}`;
    return `{"op":"set_exit_description","loc":"${t.where}","direction":"${t.direction}","text":"..."}`;
}
/** The targets as the rewrite question lists them: each text as it was before the change (never the current proposal,
 *  which the model would only echo), and for a light touch on an appended text, the added part to edit. */
export function targetLines(targets, rewrite = 'light') {
    return targets.map((t, n) => [`${n + 1}. ${t.label}. Answer with ${answerShape(t, rewrite)}`, `Before the change: ${t.was || '(empty)'}`,
        ...(appendOnly(t, rewrite) ? [`The change adds: ${t.added || '(empty)'}`, 'Answer with the added part only; the text before it stays as it is.'] : [])].join('\n')).join('\n\n');
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
 * A target left out keeps its text. Returns {ops} or {error}. An appended text comes back whole as a set_*, or as the
 * added part only (the light touch) as the same append_*.
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
        ops[t.i] = /^append_/.test(old.op) && r.op === old.op ? { ...old, text: String(text).trim() } : withText(old, String(text).trim()); // an append answered as an append stays one
    }
    return { ops, rewritten: [...done] };
}
/** The op with its text replaced by `next` (an appended text comes back whole, as a set_*). Structure is untouched. */
export function withText(old, next) {
    if (old.op === 'set_exit') return { ...old, fields: { ...old.fields, description: next } };
    if (old.op === 'update_area') return { ...old, lore: next };
    if (old.op === 'append_description') return { ...old, op: 'set_description', text: next };
    if (old.op === 'append_lore') return { ...old, op: 'set_lore', text: next };
    return { ...old, text: next };
}

// ---- Reverting a temporary change that later changes wrote on top of (the place twin of people's recompose).
// A temporary op D (its "lasts" ran out, or its change was turned off) wrote a text; a later change still in force
// wrote the same text while D was there, so its text carries D's content. Plain replay would keep that content for
// good. revertNeeds finds those texts; the extension asks the model once per need (placerevert.mjs), stores the
// result as a compose record keyed by the writers, and applyRevertRecords puts it in place of the last overlapping
// writer's text. A text no later change touched needs nothing: the replay already drops D.

/** The text an op writes ('' for none). */
export const writtenText = op => str(textOfAnswer(op ?? {}));
const PLACE_KEY = 'place:';
/**
 * Texts that need a rebuild at game time `now`. `lib` is plugin/shared/patches.mjs ({opActive, parseLasts}).
 * Returns [{target, key, family, where, direction, first: {ci, oi}, slot: {ci, oi}, dropped: [writer], active: [writer]}],
 * a writer being {ci, oi, op, change}. key covers the target and every writer up to the slot (change, op, on/off, text),
 * so the same still-active set finds the same record and any edit, toggle or new writer asks again.
 */
export function revertNeeds(changes, now, lib, hashOf) {
    const writers = new Map();
    (changes ?? []).forEach((c, ci) => {
        if (c?.type !== 'patch' || !Array.isArray(c.ops)) return;
        c.ops.forEach((op, oi) => {
            const target = targetKeyOf(op);
            if (!target) return;
            const off = c.off === true, active = !off && lib.opActive(op, c, now);
            let end = Infinity;
            if (!off && !active) { try { end = Number(c.at) + lib.parseLasts(op.lasts); } catch { end = Infinity; } }
            writers.set(target, [...(writers.get(target) ?? []), { ci, oi, op, change: c, active, end, at: Number(c.at) }]);
        });
    });
    const out = [];
    for (const [target, list] of writers) {
        let first = -1, openEnd = -Infinity, slot = -1;
        list.forEach((w, j) => {
            if (!w.active) { if (first < 0) first = j; openEnd = Math.max(openEnd, w.end); return; }
            if (first >= 0 && !(Number.isFinite(w.at) && w.at >= openEnd)) slot = j; // made while a dropped writer was still in force
        });
        if (slot < 0) continue;
        const upto = list.slice(0, slot + 1);
        const key = PLACE_KEY + hashOf(JSON.stringify({ target, w: upto.map(w => [w.change.id ?? null, w.change._msg ?? null, w.oi, w.active, writtenText(w.op)]) }));
        const op = list[slot].op, fam = FAMILY[op.op];
        out.push({ target, key, family: fam, where: str(fam === 'lore' ? op.area : op.loc), direction: fam === 'exit' ? str(op.direction) : '',
            first: { ci: list[first].ci, oi: list[first].oi }, slot: { ci: list[slot].ci, oi: list[slot].oi },
            dropped: list.slice(first, slot).filter(w => !w.active), active: list.slice(first + 1, slot + 1).filter(w => w.active) });
    }
    return out;
}
/** The changes with each need that has a record (findCompose by key) using the record's text at its slot. Clones. */
export function applyRevertRecords(changes, needs, find) {
    if (!needs?.length) return changes;
    const out = changes.slice();
    for (const n of needs) {
        const rec = find(n.key);
        if (!rec || typeof rec.text !== 'string' || !rec.text.trim()) continue;
        const c = out[n.slot.ci];
        const ops = c.ops.slice();
        ops[n.slot.oi] = withText(ops[n.slot.oi], rec.text.trim());
        out[n.slot.ci] = { ...c, ops, _rebuilt: [...(c._rebuilt ?? []), n.key] };
    }
    return out;
}
/** The changes the base text is read from: everything before the first dropped writer. */
export function revertBase(changes, need) {
    const { ci, oi } = need.first, c = changes[ci];
    return [...changes.slice(0, ci), ...(oi > 0 ? [{ ...c, ops: c.ops.slice(0, oi) }] : [])];
}
