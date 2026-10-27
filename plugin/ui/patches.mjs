// Map patches: lasting changes to a chat's world (a fire, a collapse, a door smashed open), stamped on the chat message
// where the change settled. Pure functions on the plain world JSON, shared by the server (plugin/changes.mjs) and the
// browser (extension, map window). World files are never written: the effective map is the base world plus the patches
// still stamped on the chat, applied in message order. Deleting the message undoes its patch.
//
// A patch is one chat change: {type: "patch", id, note, at (game seconds when stamped), ops: [...]}
// Ops (addresses are "region:sub/loc"; areas are "region:sub"; every op may carry "lasts": "3d" / "12h" / "30m"):
//   {op: "set_description" | "append_description", loc, text}
//   {op: "set_name", loc, text}
//   {op: "set_notes" | "append_notes", area, text}            notes of a subregion ("region:sub") or region ("region")
//   {op: "block_exit" | "open_exit" | "lock_exit" | "unlock_exit" | "break_exit" | "remove_exit", loc, direction}
//   {op: "remove_location", loc}
//   {op: "merge", locs: [...], into?: one of locs, id?, name?, description?, area?}
//       into: keep that room (rewritten with name/description if given); otherwise a new room `id` in `area`
//       (default: the subregion most of the rooms are in). Exits between merged rooms disappear, outside exits lead
//       to the merged room. Merging every room of a subregion is a collapse.

export const OPS = ['set_description', 'append_description', 'set_name', 'set_notes', 'append_notes',
    'block_exit', 'open_exit', 'lock_exit', 'unlock_exit', 'break_exit', 'remove_exit', 'remove_location', 'merge'];
export const MAX_OPS = 20, MAX_TEXT = 1500, MAX_PATCH_NAME = 60;

export class PatchError extends Error {}
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const has = (o, k) => isObj(o) && Object.prototype.hasOwnProperty.call(o, k);
const str = v => (typeof v === 'string' ? v.trim() : '');
const lc = s => String(s ?? '').toLowerCase();
const SLUG = /^[a-z0-9]+(_[a-z0-9]+)*$/;

/** "3d", "12h", "1w 2d", "90m", "45s" -> seconds. Throws on anything else. */
export function parseLasts(v) {
    if (typeof v === 'number' && v > 0) return v;
    const s = str(v).toLowerCase();
    const parts = [...s.matchAll(/(\d+(?:\.\d+)?)\s*(w|d|h|m|s)[a-z]*/g)];
    if (!s || !parts.length || parts.map(p => p[0]).join('').replace(/\s/g, '') !== s.replace(/\s|,|and/g, '')) throw new PatchError(`"lasts" must look like "3d", "12h" or "30m", got ${JSON.stringify(v)}`);
    const unit = { w: 604800, d: 86400, h: 3600, m: 60, s: 1 };
    return parts.reduce((t, p) => t + Number(p[1]) * unit[p[2]], 0);
}

/** Is this op still in force at game time `now` (seconds)? Ops without "lasts", or with no clock, always are. */
export function opActive(op, patch, now) {
    if (!has(op, 'lasts') || now === null || now === undefined || !Number.isFinite(Number(patch?.at))) return true;
    try { return now < Number(patch.at) + parseLasts(op.lasts); } catch { return true; } // a bad "lasts" is reported when applied
}
/**
 * Temporary patch ops that run out after game time `before` and by `after` (a wait or a journey):
 * [{patch, op, note, ends}] in the order they run out.
 */
export function expiredBetween(changes = [], before = 0, after = 0) {
    const out = [];
    for (const c of changes ?? []) {
        if (c?.type !== 'patch' || !Array.isArray(c.ops) || !Number.isFinite(Number(c.at))) continue;
        c.ops.forEach((op, i) => {
            if (!has(op, 'lasts')) return;
            let ends; try { ends = Number(c.at) + parseLasts(op.lasts); } catch { return; }
            if (ends > before && ends <= after) out.push({ patch: c.id, op, note: c.summary?.[i] ?? c.note ?? String(op.op ?? '').replace(/_/g, ' '), ends });
        });
    }
    return out.sort((a, b) => a.ends - b.ends);
}
/** The changes with expired patch ops dropped (patches left with no ops dropped too). */
export function activeChanges(changes = [], now = null) {
    return (changes ?? []).flatMap(c => {
        if (c?.type !== 'patch' || !Array.isArray(c.ops)) return [c];
        const ops = c.ops.filter(o => opActive(o, c, now));
        return ops.length ? [ops.length === c.ops.length ? c : { ...c, ops }] : [];
    });
}

export const resolveRef = (ref, region, sub) => (ref.includes(':') ? ref : ref.includes('/') ? `${region}:${ref}` : `${region}:${sub}/${ref}`);
function split(address) {
    const m = /^([^:]+):([^/]+)\/(.+)$/.exec(String(address ?? ''));
    return m ? [m[1], m[2], m[3]] : null;
}
function* eachRoom(raw) {
    for (const [rid, reg] of Object.entries(raw)) if (isObj(reg?.subregions))
        for (const [sid, sub] of Object.entries(reg.subregions)) if (isObj(sub?.locations))
            for (const [lid, loc] of Object.entries(sub.locations)) yield [`${rid}:${sid}/${lid}`, loc, rid, sid, lid];
}
/** Every exit "to" and view written as a full address, so rooms can move between subregions safely. */
export function normalizeRefs(raw) {
    for (const [, loc, rid, sid] of eachRoom(raw)) {
        if (Array.isArray(loc.exits)) for (const e of loc.exits) if (isObj(e) && typeof e.to === 'string') e.to = resolveRef(e.to.trim(), rid, sid);
        if (Array.isArray(loc.views)) loc.views = loc.views.map(v => (typeof v === 'string' ? resolveRef(v.trim(), rid, sid) : v));
    }
}
export function getRoom(raw, address) {
    const p = split(address);
    const r = p && raw[p[0]]?.subregions?.[p[1]]?.locations;
    return p && isObj(r) && has(r, p[2]) ? r[p[2]] : null;
}
const nameOf = (raw, a) => getRoom(raw, a)?.name ?? a;

/**
 * Apply one patch to the plain world JSON in place (raw: {regionId: regionJson}; worldJson unused for now).
 * Returns {summary: [readable lines], relocate: {oldAddress: newAddress}, touched: [addresses and areas]}.
 * Throws PatchError with a clear message on an invalid op.
 */
export function applyPatch(raw, patch, { now = null, where = 'patch' } = {}) {
    if (!isObj(patch) || !Array.isArray(patch.ops)) throw new PatchError(`${where}: "ops" must be a list`);
    if (!patch.ops.length) throw new PatchError(`${where}: no ops`);
    if (patch.ops.length > MAX_OPS) throw new PatchError(`${where}: at most ${MAX_OPS} ops`);
    normalizeRefs(raw);
    const out = { summary: [], relocate: {}, touched: [] };
    patch.ops.forEach((op, i) => {
        const w = `${where}, op #${i + 1}`;
        if (!isObj(op) || !OPS.includes(op.op)) throw new PatchError(`${w}: unknown op ${JSON.stringify(isObj(op) ? op.op : op)} (known: ${OPS.join(', ')})`);
        if (has(op, 'lasts')) { try { parseLasts(op.lasts); } catch (e) { throw new PatchError(`${w}: ${e.message}`); } }
        if (!opActive(op, patch, now)) return;
        const line = applyOp(raw, op, w, out);
        out.summary.push(has(op, 'lasts') ? `${line} (for ${str(String(op.lasts))})` : line);
    });
    return out;
}

function needRoom(raw, a, w, key = 'loc') {
    const r = typeof a === 'string' ? getRoom(raw, a.trim()) : null;
    if (!r) throw new PatchError(`${w}: "${key}" ${JSON.stringify(a)} is not a room (addresses look like "region:subregion/room")`);
    return r;
}
function needText(op, w, key = 'text', max = MAX_TEXT) {
    const t = str(op[key]);
    if (!t) throw new PatchError(`${w}: "${key}" must be a non-empty string`);
    if (t.length > max) throw new PatchError(`${w}: "${key}" is too long (at most ${max} characters)`);
    return t;
}
const relocateTo = (out, from, to) => {
    for (const [k, v] of Object.entries(out.relocate)) if (v === from) out.relocate[k] = to;
    if (from !== to) out.relocate[from] = to;
};

function applyOp(raw, op, w, out) {
    switch (op.op) {
        case 'set_description': case 'append_description': case 'set_name': {
            const a = str(op.loc), r = needRoom(raw, a, w), t = needText(op, w, 'text', op.op === 'set_name' ? MAX_PATCH_NAME : MAX_TEXT);
            out.touched.push(a);
            if (op.op === 'set_name') { const old = r.name; r.name = t; return `${old} is now called ${t}`; }
            r.description = op.op === 'set_description' ? t : `${str(r.description)} ${t}`.trim();
            return `${r.name}: description ${op.op === 'set_description' ? 'rewritten' : 'added to'}`;
        }
        case 'set_notes': case 'append_notes': {
            const area = str(op.area), [rid, sid] = area.split(':');
            const obj = sid ? raw[rid]?.subregions?.[sid] : raw[rid];
            if (!isObj(obj) || !rid) throw new PatchError(`${w}: "area" ${JSON.stringify(op.area)} is not a region ("region") or subregion ("region:subregion")`);
            const t = needText(op, w);
            obj.notes = op.op === 'set_notes' ? t : `${str(obj.notes)} ${t}`.trim();
            out.touched.push(area);
            return `${obj.name ?? area}: notes ${op.op === 'set_notes' ? 'rewritten' : 'added to'}`;
        }
        case 'block_exit': case 'open_exit': case 'lock_exit': case 'unlock_exit': case 'break_exit': case 'remove_exit':
            return exitOp(raw, op, w, out);
        case 'remove_location': return removeOp(raw, op, w, out);
        case 'merge': return mergeOp(raw, op, w, out);
    }
    throw new PatchError(`${w}: unknown op`);
}

function findExit(raw, a, d, w) {
    const r = needRoom(raw, a, w);
    const dir = needText({ d }, w, 'd', 60);
    const ex = (r.exits ?? []).find(e => isObj(e) && lc(e.direction) === lc(dir));
    if (!ex) throw new PatchError(`${w}: ${r.name} has no exit ${JSON.stringify(dir)} (exits: ${(r.exits ?? []).map(e => e.direction).join(', ') || 'none'})`);
    const backRoom = getRoom(raw, ex.to);
    const back = backRoom ? (backRoom.exits ?? []).find(e => isObj(e) && e.to === a) ?? null : null;
    return { r, ex, back, backRoom };
}
function exitOp(raw, op, w, out) {
    const a = str(op.loc), { r, ex, back, backRoom } = findExit(raw, a, op.direction, w);
    out.touched.push(a, ex.to);
    const label = `${r.name} ${ex.direction} exit${backRoom ? ` (to ${backRoom.name})` : ''}`;
    if (op.op === 'remove_exit') {
        r.exits = r.exits.filter(e => e !== ex);
        if (back) backRoom.exits = backRoom.exits.filter(e => e !== back);
        return `${label} removed`;
    }
    const own = isObj(ex.barrier) ? ex.barrier : isObj(back?.barrier) ? back.barrier : {};
    const clearBack = () => { if (back) { delete back.barrier; if (back.view === 'closed') delete back.view; } };
    if (ex.view === 'closed') delete ex.view;
    if (op.op === 'break_exit') {
        delete ex.barrier; clearBack();
        if (ex.hidden || ex.obscured) ex.view = 'open';
        if (back && (back.hidden || back.obscured)) back.view = 'open';
        return `${label} broken open (no door any more)`;
    }
    const b = { ...own };
    if (op.op === 'block_exit') Object.assign(b, { openable: false, starts_open: false });
    if (op.op === 'open_exit') Object.assign(b, { openable: true, starts_open: true, locked: false });
    if (op.op === 'lock_exit') Object.assign(b, { openable: true, starts_open: false, locked: true });
    if (op.op === 'unlock_exit') Object.assign(b, { openable: true, locked: false });
    ex.barrier = b; clearBack();
    return `${label} ${{ block_exit: 'blocked', open_exit: 'opened', lock_exit: 'locked', unlock_exit: 'unlocked' }[op.op]}`;
}

/** Drop every exit and view into `gone` (a Set), except the ones redirected by `to` (a function address -> new). */
function rewire(raw, gone, target) {
    for (const [addr, loc] of eachRoom(raw)) {
        if (gone.has(addr)) continue;
        if (Array.isArray(loc.exits)) {
            const kept = [], seen = new Set();
            for (const e of loc.exits) {
                if (!isObj(e) || !gone.has(e.to)) { kept.push(e); continue; }
                if (!target || target === addr) continue;
                if (kept.some(k => k.to === target) || seen.has(target)) continue; // two doors into the merged room: one is enough
                seen.add(target);
                kept.push({ ...e, to: target });
            }
            loc.exits = kept;
        }
        if (Array.isArray(loc.views)) loc.views = [...new Set(loc.views.flatMap(v => (gone.has(v) ? (target && target !== addr ? [target] : []) : [v])))];
    }
}
/** Entrances and starts that pointed at removed rooms (or emptied subregions) point somewhere valid again. */
function fixEntrances(raw, gone, target) {
    for (const [rid, reg] of Object.entries(raw)) {
        if (!isObj(reg?.subregions)) continue;
        for (const [sid, sub] of Object.entries(reg.subregions)) {
            if (isObj(sub.locations) && !Object.keys(sub.locations).length) { delete reg.subregions[sid]; continue; }
            if (has(sub, 'entrance') && gone.has(`${rid}:${sid}/${sub.entrance}`)) {
                const t = split(target);
                if (t && t[0] === rid && t[1] === sid) sub.entrance = t[2]; else delete sub.entrance;
            }
        }
        const valid = rel => { const [s, l] = String(rel).split('/'); return isObj(reg.subregions[s]) && (l === undefined || has(reg.subregions[s].locations, l)); };
        const fallback = () => { const t = split(target); if (t && t[0] === rid) return `${t[1]}/${t[2]}`; const [s, sub] = Object.entries(reg.subregions)[0]; return `${s}/${Object.keys(sub.locations)[0]}`; };
        if (typeof reg.start === 'string' && !valid(reg.start)) reg.start = fallback();
        if (typeof reg.entrance === 'string' && !valid(reg.entrance)) delete reg.entrance;
    }
}
const roomsIn = (raw, rid) => Object.values(raw[rid]?.subregions ?? {}).reduce((n, s) => n + Object.keys(s?.locations ?? {}).length, 0);

function removeOp(raw, op, w, out) {
    const a = str(op.loc), r = needRoom(raw, a, w), [rid, sid, lid] = split(a);
    if (roomsIn(raw, rid) <= 1) throw new PatchError(`${w}: can't remove ${r.name}, the last room of its region`);
    const sub = raw[rid].subregions[sid];
    const near = (r.exits ?? []).map(e => e.to).find(t => t !== a && getRoom(raw, t) && split(t)[0] === rid)
        ?? Object.keys(sub.locations).filter(l => l !== lid).map(l => `${rid}:${sid}/${l}`)[0]
        ?? [...eachRoom(raw)].find(([x, , r2]) => r2 === rid && x !== a)[0];
    delete sub.locations[lid];
    const gone = new Set([a]);
    rewire(raw, gone, null);
    fixEntrances(raw, gone, near);
    relocateTo(out, a, near);
    out.touched.push(a);
    return `${r.name} removed (anyone there ends up in ${nameOf(raw, near)})`;
}

function mergeOp(raw, op, w, out) {
    if (!Array.isArray(op.locs) || !op.locs.length) throw new PatchError(`${w}: "locs" must be a list of room addresses`);
    const locs = [...new Set(op.locs.map(str))];
    locs.forEach(a => needRoom(raw, a, w, 'locs'));
    const into = str(op.into);
    if (into && !locs.includes(into)) throw new PatchError(`${w}: "into" must be one of "locs" (or leave it out and give "id", "name" and "description" for a new room)`);
    if (!into && locs.length < 2 && !str(op.id)) throw new PatchError(`${w}: merge needs at least two rooms`);
    const regions = new Set(locs.map(a => split(a)[0]));
    // Where the merged room lives: "area" if given, else the kept room's subregion, else the majority subregion.
    let area = str(op.area);
    if (!area) {
        if (into) area = into.slice(0, into.indexOf('/'));
        else { const n = new Map(); for (const a of locs) { const k = a.slice(0, a.indexOf('/')); n.set(k, (n.get(k) ?? 0) + 1); } area = [...n].sort((x, y) => y[1] - x[1])[0][0]; }
    }
    const [arid, asid] = area.split(':');
    if (!asid || !isObj(raw[arid]?.subregions?.[asid])) throw new PatchError(`${w}: "area" ${JSON.stringify(area)} is not a subregion ("region:subregion")`);
    if (!regions.has(arid) && regions.size) throw new PatchError(`${w}: "area" must be in the same region as the merged rooms`);
    let target;
    if (into && !str(op.area)) target = into;
    else {
        const id = str(op.id) || (into ? split(into)[2] : '');
        if (!SLUG.test(id)) throw new PatchError(`${w}: "id" ${JSON.stringify(op.id)} must be a room id (lowercase letters, digits and single underscores)`);
        target = `${arid}:${asid}/${id}`;
        if (getRoom(raw, target) && !locs.includes(target)) throw new PatchError(`${w}: a room ${target} already exists (pick another "id")`);
    }
    const base = into ? structuredClone(getRoom(raw, into)) : {};
    const oldNames = locs.map(a => nameOf(raw, a));
    if (!into) { needText(op, w, 'name', MAX_PATCH_NAME); needText(op, w, 'description'); }
    if (str(op.name)) base.name = needText(op, w, 'name', MAX_PATCH_NAME);
    if (str(op.description)) base.description = needText(op, w, 'description');
    delete base.pos;
    const set = new Set(locs);
    const exits = [], dirs = new Set(), targets = new Set();
    for (const a of into ? [into, ...locs.filter(x => x !== into)] : locs) for (const e of getRoom(raw, a).exits ?? []) {
        if (!isObj(e) || set.has(e.to) || targets.has(e.to)) continue;
        let d = str(e.direction), n = 2;
        while (dirs.has(lc(d))) d = `${str(e.direction)} ${n++}`;
        dirs.add(lc(d)); targets.add(e.to);
        exits.push({ ...e, direction: d });
    }
    base.exits = exits;
    base.views = [...new Set(locs.flatMap(a => getRoom(raw, a).views ?? []).filter(v => !set.has(v)))];
    if (!base.views.length) delete base.views;
    for (const a of locs) { const [r, s, l] = split(a); delete raw[r].subregions[s].locations[l]; }
    const [, , tl] = split(target);
    raw[arid].subregions[asid].locations ??= {};
    raw[arid].subregions[asid].locations[tl] = base;
    const gone = new Set(locs.filter(a => a !== target));
    rewire(raw, gone, target);
    fixEntrances(raw, new Set(locs), target);
    for (const a of gone) relocateTo(out, a, target);
    out.touched.push(...locs, target);
    const sub = raw[arid].subregions[asid];
    const whole = Object.keys(sub.locations).length === 1 ? ' (the whole area collapses into one place)' : '';
    return `${oldNames.join(', ')} merged into ${base.name}${into ? '' : ' (new room)'}${whole}`;
}

/** Plain-language lines for a patch without applying it (for cards when the world isn't at hand). */
export function describeOps(ops = []) {
    return (ops ?? []).map(o => {
        const t = o?.loc ?? o?.area ?? (o?.locs ?? []).join(', ');
        const d = o?.direction ? ` ${o.direction}` : '';
        return `${String(o?.op ?? '?').replace(/_/g, ' ')}: ${t}${d}${o?.lasts ? ` (for ${o.lasts})` : ''}`;
    });
}

/** Address after this chat's patches moved it (merged or removed rooms), following chains. */
export function relocated(address, changes = []) {
    let a = address;
    for (const c of changes ?? []) if (c?.type === 'patch' && isObj(c.relocate) && has(c.relocate, a)) a = c.relocate[a];
    return a;
}
