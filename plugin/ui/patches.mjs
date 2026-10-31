// Map patches: lasting changes to a chat's world (a fire, a collapse, a door smashed open), stamped on the chat message
// where the change settled. Pure functions on the plain world JSON, shared by the server (plugin/changes.mjs) and the
// browser (extension, map window). World files are never written: the effective map is the base world plus the patches
// still stamped on the chat, applied in message order. Deleting the message undoes its patch.
//
// A patch is one chat change: {type: "patch", id, note, at (game seconds when stamped), ops: [...]}
// Ops (addresses are "region:sub/loc"; areas are "region:sub"; every op may carry "lasts": "3d" / "12h" / "30m"):
//   {op: "set_description" | "append_description", loc, text}
//   {op: "set_name", loc, text}
//   {op: "set_lore" | "append_lore", area, text}            notes of a subregion ("region:sub") or region ("region")
//   {op: "block_exit" | "open_exit" | "lock_exit" | "unlock_exit" | "break_exit" | "remove_exit", loc, direction}
//   {op: "remove_location", loc}
//   {op: "merge", locs: [...], into?: one of locs, id?, name?, description?, area?}
//       into: keep that room (rewritten with name/description if given); otherwise a new room `id` in `area`
//       (default: the subregion most of the rooms are in). Exits between merged rooms disappear, outside exits lead
//       to the merged room. Merging every room of a subregion is a collapse.
//   {op: "discover", loc, direction, name, description, id?, return_direction?, exit_description?, return_description?, door?}
//       A room found behind set dressing (a door the description only mentions): a new room `id` (made by the engine
//       from the name when missing, stamped with the patch) in loc's subregion, joined to loc by one exit pair (a door
//       unless door: false). Refused where "expandable" is false (the room's own setting, else its subregion's, else
//       its region's, else world.json's; default true). Written as if it was always there.
//   {op: "set_expandable", target, value}   target: a room, "region:sub" or "region"; value true, false or null
//       (null / "inherit": drop the setting so the next level up decides).
//   {op: "set_fields", target, fields: {key: value | null}}   the map's Edit forms: plain settings of a room, subregion
//       ("region:sub") or region ("region"); null drops the setting (inherit / default). Allowed keys: FIELD_KEYS.
//   {op: "set_exit", loc, direction, fields: {key: value | null}}   one exit's settings. Per side (only this side changes):
//       direction, description, type, sight, sound, traversal, hidden, obscured. Shared by the pair (synced to the way back):
//       travel_time and barrier (the door: an object, or null for no door).
//   {op: "add_exit", loc, direction, to, return_direction?, travel_time?, description?, return_description?, door?}
//       a new exit pair between two existing rooms (one way when return_direction is empty and one_way is true).
//   {op: "move_location", loc, area, id?}   a room moves to another subregion (any region); it keeps its exits, and its
//       id unless "id" renames it. A taken id is refused with a suggested free one (PatchError.clash), never overwritten.
//       The old address redirects to the new one (relocate), like a merge.
//   {op: "move_area", area: "region:sub", region, id?}   a subregion (with all its places) moves to another region.
//   {op: "create_place", area, name, description, id?, exits: [{direction, to, return_direction, travel_time?, door?,
//       description?, return_description?}]}   a new place joined to at least one existing place.
//   {op: "create_subregion", region, name, notes?, id?, place: {name, description, id?, exits: [...]}}   with its first place.
//   {op: "create_region", name, notes?, id?, subregion: {name, notes?, id?, place: {...}}}   with its first subregion and
//       starting place (exits optional here).
//   {op: "remove_area", area, contents: "delete" | "move", into?, ids?: {oldId: newId}}   deletes a subregion ("region:sub")
//       or region ("region"); its places (or subregions) are deleted, or moved into "into" (a subregion / region): that is
//       also how two containers merge. Anyone inside a deleted place ends up in the nearest place that is left.
//   Emptying a container deletes it too (the last place of a subregion, the last subregion of a region); the world's
//   starting region and the last region are never deleted.

import { parseDuration } from './calendar.mjs';
import { flipBar } from './doorbar.mjs';
import { render as P } from './prompts.mjs';
export const OPS = ['set_description', 'append_description', 'set_name', 'set_lore', 'append_lore', 'update_area',
    'block_exit', 'open_exit', 'lock_exit', 'unlock_exit', 'break_exit', 'remove_exit', 'set_exit_description', 'set_travel_time', 'remove_location', 'merge', 'discover', 'set_expandable',
    'set_fields', 'set_exit', 'add_exit', 'move_location', 'move_area', 'create_place', 'create_subregion', 'create_region', 'remove_area'];
/** What set_fields may change at each level (name, description, notes and expandable have their own ops). */
export const FIELD_KEYS = {
    room: ['lore', 'inherit_region_lore', 'inherit_subregion_lore', 'exposure', 'indoor_temp', 'insulation', 'temp_offset'],
    subregion: ['inherit_lore', 'label_rooms', 'stays_open', 'entrance', 'exposure', 'indoor_temp', 'insulation', 'temp_offset'],
    region: ['stays_open', 'entrance', 'exposure', 'indoor_temp', 'insulation', 'temp_offset'],
};
export const EXIT_SIDE_KEYS = ['direction', 'description', 'type', 'sight', 'sound', 'traversal', 'hidden', 'obscured'];
export const EXIT_SHARED_KEYS = ['travel_time', 'barrier'];
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
/** The changes with expired patch ops dropped (patches left with no ops dropped too), and turned-off changes skipped. */
export function activeChanges(changes = [], now = null) {
    return (changes ?? []).flatMap(c => {
        if (c?.off === true) return []; // turned off retroactively: stays stored on its message, skipped in the replay
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
/** A new room id from whatever the model wrote: the last segment of an address, lowercased, other characters -> "_". */
export const slugId = v => String(v ?? '').trim().split(/[:/]/).pop().toLowerCase().replace(/['\u2019\u2018]/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
/** A room reference as a full address: an existing address as is, else a unique room matching "sub/id" or "id" (any case). */
export function resolveRoom(raw, ref) {
    const a = String(ref ?? '').trim();
    if (!a || getRoom(raw, a)) return a;
    const lower = a.toLowerCase();
    if (getRoom(raw, lower)) return lower;
    const tail = lower.includes(':') ? lower.slice(lower.indexOf(':') + 1) : lower;
    const hits = roomMatches(raw, a);
    return hits.length === 1 ? hits[0] : a;
}
/** Every room a partial reference ("sub/id" or a bare "id", any case) could mean. Several = ambiguous: the card asks. */
export function roomMatches(raw, ref) {
    const lower = String(ref ?? '').trim().toLowerCase();
    if (!lower) return [];
    if (getRoom(raw, lower)) return [lower];
    const tail = lower.includes(':') ? lower.slice(lower.indexOf(':') + 1) : lower;
    return [...eachRoom(raw)].map(x => x[0]).filter(addr => addr.toLowerCase().endsWith(tail.includes('/') ? `:${tail}` : `/${slugId(tail)}`));
}
/** The id a brand-new room named `name` gets: slugified name ("The Burned Hall" -> "the_burned_hall"). */
export const newRoomId = name => slugId(String(name ?? '').replace(/[:/]/g, ' ')).slice(0, 60).replace(/_+$/, '');
/** `${area}/${id}`, or with _2, _3... if a room (other than one of `except`) already has it. */
export function freeAddress(raw, area, id, except = []) {
    let a = `${area}/${id}`, n = 2;
    while (getRoom(raw, a) && !except.includes(a)) a = `${area}/${id}_${n++}`;
    return a;
}
/**
 * A place made earlier in the same patch, by a reference: "new:<ref>" (the "ref" label a create_place or create_subregion
 * gave it), or a guessed address that is not a room but whose last part, or the whole thing slugged, is the new place's id
 * or slugged name (e.g. "riverton:secret_mind_dimension/secret_mind_dimension" for a new "Secret Mind Dimension").
 * Returns the address, '' for an unknown "new:" label, or null when the reference is not about a new place.
 */
export function madeRef(raw, ref, made) {
    const a = String(ref ?? '').trim();
    if (!a) return null;
    const m = /^new:\s*(.+)$/i.exec(a);
    if (m) { const k = m[1].trim().toLowerCase(), hit = made.find(x => x.ref && x.ref === k) ?? made.find(x => x.id === slugId(k) || newRoomId(x.name) === newRoomId(k)); return hit ? hit.address : ''; }
    if (!made.length || getRoom(raw, a) || getRoom(raw, a.toLowerCase())) return null;
    const last = slugId(a.toLowerCase().split(/[/:]/).pop()), whole = newRoomId(a);
    const hits = made.filter(x => x.id === last || newRoomId(x.name) === last || x.id === whole || newRoomId(x.name) === whole);
    return hits.length === 1 ? hits[0].address : null;
}
/** Every room reference in an op that points at a place made earlier in this patch, written as its real address. */
export function madeRefs(raw, op, made, w = 'patch') {
    if (!isObj(op)) return op;
    const fix = v => { if (typeof v !== 'string') return v; const r = madeRef(raw, v, made); if (r === '') throw new PatchError(`${w}: ${JSON.stringify(v)} names no place made earlier in this patch (give the create_place a "ref")`); return r ?? v; };
    const o = { ...op };
    for (const k of ['loc', 'into', 'to', 'target']) if (k in o) o[k] = fix(o[k]);
    if (Array.isArray(o.locs)) o.locs = o.locs.map(fix);
    const fixExits = p => (isObj(p) && Array.isArray(p.exits) ? { ...p, exits: p.exits.map(e => (isObj(e) ? { ...e, to: fix(e.to) } : e)) } : p);
    if (Array.isArray(o.exits)) Object.assign(o, fixExits(o));
    if (isObj(o.place)) o.place = fixExits(o.place);
    if (isObj(o.subregion) && isObj(o.subregion.place)) o.subregion = { ...o.subregion, place: fixExits(o.subregion.place) };
    return o;
}
/** One op with its room references written as full addresses and a merge's new "id" as a bare id (the area taken from a full address). */
export function normalizeOp(raw, op) {
    if (!isObj(op)) return op;
    const o = { ...op };
    for (const k of ['loc', 'into']) if (typeof o[k] === 'string' && o[k].trim()) o[k] = resolveRoom(raw, o[k]);
    if (o.op === 'set_fields' && typeof o.target === 'string' && o.target.includes('/')) o.target = resolveRoom(raw, o.target);
    if (o.op === 'add_exit' && typeof o.to === 'string' && o.to.trim()) o.to = resolveRoom(raw, o.to);
    const fixExits = p => (isObj(p) && Array.isArray(p.exits) ? { ...p, exits: p.exits.map(e => (isObj(e) && typeof e.to === 'string' ? { ...e, to: resolveRoom(raw, e.to) } : e)) } : p);
    if (o.op === 'create_place') Object.assign(o, fixExits(o));
    if (o.op === 'create_subregion') o.place = fixExits(o.place);
    if (o.op === 'create_region' && isObj(o.subregion)) o.subregion = { ...o.subregion, place: fixExits(o.subregion.place) };
    if (o.op === 'set_expandable') { if (typeof o.target === 'string' && o.target.includes('/')) o.target = resolveRoom(raw, o.target); try { o.value = expandValue(o.value, ''); } catch { /* reported by applyOp */ } }
    if (Array.isArray(o.locs)) o.locs = o.locs.map(x => (typeof x === 'string' ? resolveRoom(raw, x) : x));
    if (typeof o.area === 'string') o.area = o.area.trim().toLowerCase().replace(/\/.*$/, '');
    if (o.op === 'merge' && typeof o.id === 'string' && o.id.trim()) {
        const m = /^([^:/\s]+):([^/\s]+)\//.exec(o.id.trim().toLowerCase());
        if (m && !str(o.area) && !o.into && isObj(raw[m[1]]?.subregions?.[m[2]])) o.area = `${m[1]}:${m[2]}`;
        o.id = slugId(o.id);
    }
    if (o.op === 'create_place' && o.story === true) {
        for (const k of ['loc', 'direction', 'return_direction', 'exit_description', 'return_description', 'travel_time', 'door']) delete o[k];
        // Made by the story (a change call or a discovery): the area defaults to the first exit's room's, and the engine
        // picks the id once (from the name, never clashing) and stamps it with the op, so replays agree.
        if (!str(o.area)) { const t = split(o.exits?.find(e => isObj(e) && split(e.to))?.to); if (t) o.area = `${t[0]}:${t[1]}`; }
        if (!str(o.id) && str(o.area) && str(o.name) && isObj(getArea(raw, o.area))) o.id = split(freeAddress(raw, o.area, newRoomId(o.name) || 'room'))[2];
        else if (str(o.id)) o.id = slugId(o.id);
    }
    return o;
}
const getArea = (raw, area) => { const [r, s] = String(area ?? '').split(':'); return s ? raw[r]?.subregions?.[s] : null; };
/**
 * A discovery (from the narrator) as a story-made create_place: a new room in loc's subregion, joined to loc by one exit
 * pair (a door unless door: false). `story: true` makes the engine pick the id and respect "expandable".
 */
export function discoverToCreate(o) {
    const p = split(o.loc);
    const c = { op: 'create_place', story: true, ...(p ? { area: `${p[0]}:${p[1]}` } : {}), name: o.name, description: o.description,
        ...(str(o.id) ? { id: slugId(o.id) } : {}),
        exits: [{ to: o.loc, direction: str(o.return_direction) || 'out', return_direction: o.direction, travel_time: str(o.travel_time) || '10s',
            door: o.door !== false, description: str(o.return_description) || undefined, return_description: str(o.exit_description) || undefined }] };
    if (has(o, 'lasts')) c.lasts = o.lasts;
    return c;
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
export function applyPatch(raw, patch, { now = null, where = 'patch', dropNoops = false, world = null } = {}) {
    if (!isObj(patch) || !Array.isArray(patch.ops)) throw new PatchError(`${where}: "ops" must be a list`);
    if (!patch.ops.length) throw new PatchError(`${where}: no ops`);
    if (patch.ops.length > MAX_OPS) throw new PatchError(`${where}: at most ${MAX_OPS} ops`);
    normalizeRefs(raw);
    const out = { summary: [], relocate: {}, touched: [], ops: [], noops: [] };
    patch.ops.forEach((op0, i) => {
        const op = normalizeOp(raw, madeRefs(raw, op0, out.made ?? [], `${where}, op #${i + 1}`));
        const why = dropNoops ? noopOf(raw, op) : '';
        if (why) { out.noops.push({ i, why }); return; } // e.g. a rename to the same name: dropped, nothing stamped
        out.ops.push(op);
        const w = `${where}, op #${i + 1}`;
        if (!isObj(op) || !OPS.includes(op.op)) throw new PatchError(`${w}: unknown op ${JSON.stringify(isObj(op) ? op.op : op)} (known: ${OPS.join(', ')})`);
        if (has(op, 'lasts')) { try { parseLasts(op.lasts); } catch (e) { throw new PatchError(`${w}: ${e.message}`); } }
        if (!opActive(op, patch, now)) return;
        const line = applyOp(raw, op, w, out, world);
        out.summary.push(has(op, 'lasts') ? `${line} (for ${str(String(op.lasts))})` : line);
    });
    if (!out.ops.length) throw new PatchError(`${where}: nothing changes (${out.noops.map(n => n.why).join('; ')})`);
    return out;
}

/** Why an op changes nothing on the map as it stands (same name, identical text), or '' if it does something. */
export function noopOf(raw, op) {
    if (!isObj(op)) return '';
    const same = (a, b) => str(a) !== '' && str(a) === str(b);
    if (op.op === 'set_name' || op.op === 'set_description') {
        const r = typeof op.loc === 'string' ? getRoom(raw, op.loc.trim()) : null;
        if (!r) return '';
        if (op.op === 'set_name' && same(op.text, r.name)) return `${r.name} already has that name`;
        if (op.op === 'set_description' && same(op.text, r.description)) return `${r.name ?? op.loc}: description is already that`;
    }
    if (op.op === 'set_lore' || op.op === 'update_area') {
        const [rid, sid] = str(op.area).split(':'), obj = sid ? raw[rid]?.subregions?.[sid] : raw[rid];
        if (!isObj(obj)) return '';
        const n = op.op === 'set_lore' ? op.text : op.lore;
        if (op.op === 'set_lore') return same(n, obj.lore) ? `${obj.name ?? op.area}: notes are already that` : '';
        const nameNo = !str(op.name) || same(op.name, obj.name), notesNo = !str(n) || same(n, obj.lore);
        if (nameNo && notesNo) return `${obj.name ?? op.area} already has that name and notes`;
    }
    return '';
}

function needRoom(raw, a, w, key = 'loc') {
    const r = typeof a === 'string' ? getRoom(raw, a.trim()) : null;
    if (!r && typeof a === 'string') { const m = roomMatches(raw, a); if (m.length > 1) { const e = new PatchError(`${w}: "${key}" ${JSON.stringify(a)} could be ${m.join(' or ')}; pick one`); e.choices = m; e.key = key; throw e; } }
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

function applyOp(raw, op, w, out, world = null) {
    switch (op.op) {
        case 'set_description': case 'append_description': case 'set_name': {
            const a = str(op.loc), r = needRoom(raw, a, w), t = needText(op, w, 'text', op.op === 'set_name' ? MAX_PATCH_NAME : MAX_TEXT);
            out.touched.push(a);
            if (op.op === 'set_name') { const old = r.name; r.name = t; return `${old} is now called ${t}`; }
            r.description = op.op === 'set_description' ? t : `${str(r.description)} ${t}`.trim();
            return `${r.name}: description ${op.op === 'set_description' ? 'rewritten' : 'added to'}`;
        }
        case 'set_lore': case 'append_lore': {
            const area = str(op.area), [rid, sid] = area.split(':');
            const obj = sid ? raw[rid]?.subregions?.[sid] : raw[rid];
            if (!isObj(obj) || !rid) throw new PatchError(`${w}: "area" ${JSON.stringify(op.area)} is not a region ("region") or subregion ("region:subregion")`);
            const t = needText(op, w);
            obj.lore = op.op === 'set_lore' ? t : `${str(obj.lore)} ${t}`.trim();
            out.touched.push(area);
            return `${obj.name ?? area}: notes ${op.op === 'set_lore' ? 'rewritten' : 'added to'}`;
        }
        case 'update_area': {
            // A region or subregion's display name and/or notes; its id (and every room address in it) never changes.
            const area = str(op.area), [rid, sid] = area.split(':');
            const obj = sid ? raw[rid]?.subregions?.[sid] : raw[rid];
            if (!isObj(obj) || !rid) throw new PatchError(`${w}: "area" ${JSON.stringify(op.area)} is not a region ("region") or subregion ("region:subregion")`);
            if (!str(op.name) && !str(op.lore)) throw new PatchError(`${w}: update_area needs a "name" and/or "lore"`);
            const old = obj.name ?? area, bits = [];
            if (str(op.name) && str(op.name) !== str(obj.name)) { obj.name = needText(op, w, 'name', MAX_PATCH_NAME); bits.push(`now called ${obj.name}`); }
            if (str(op.lore) && str(op.lore) !== str(obj.lore)) { obj.lore = needText(op, w, 'lore'); bits.push('notes rewritten'); }
            out.touched.push(area);
            return `${old}: ${bits.join(', ') || 'unchanged'}`;
        }
        case 'block_exit': case 'open_exit': case 'lock_exit': case 'unlock_exit': case 'break_exit': case 'remove_exit':
            return exitOp(raw, op, w, out);
        case 'set_exit_description': {
            // Per side: only this side's text changes; the way back keeps its own (an exit pair shares only its door state).
            const a = str(op.loc), { r, ex } = findExit(raw, a, op.direction, w), t = needText(op, w, 'text', 400);
            ex.description = t; out.touched.push(a);
            return `${r.name} ${ex.direction} exit: description rewritten (this side only)`;
        }
        case 'set_travel_time': {
            // Shared by an exit pair: the way back takes the same time.
            const a = str(op.loc), { r, ex, back } = findExit(raw, a, op.direction, w), t = needText(op, w, 'time', 20);
            try { parseDuration(t); } catch (err) { throw new PatchError(`${w}: "time": ${err.message}`); }
            ex.travel_time = t; if (back) back.travel_time = t;
            out.touched.push(a, ex.to);
            return `${r.name} ${ex.direction} exit: travel time ${t} (both ways)`;
        }
        case 'remove_location': return removeOp(raw, op, w, out, world);
        case 'merge': return mergeOp(raw, op, w, out);
        case 'set_expandable': {
            const t = str(op.target), p = split(t), [rid, sid] = p ?? t.split(':');
            const obj = p ? getRoom(raw, t) : sid ? raw[rid]?.subregions?.[sid] : raw[rid];
            if (!isObj(obj) || !rid) throw new PatchError(`${w}: "target" ${JSON.stringify(op.target)} is not a room, subregion ("region:subregion") or region ("region")`);
            const v = expandValue(op.value, w);
            if (v === null) delete obj.expandable; else obj.expandable = v;
            out.touched.push(t);
            return `${obj.name ?? t}: ${v === null ? 'discoveries follow the level above' : v ? 'new rooms can be discovered' : 'no new rooms can be discovered'}`;
        }
        case 'set_fields': return fieldsOp(raw, op, w, out);
        case 'set_exit': return setExitOp(raw, op, w, out);
        case 'add_exit': return addExitOp(raw, op, w, out);
        case 'move_location': {
            const a = str(op.loc), r = needRoom(raw, a, w), area = str(op.area);
            if (area === a.slice(0, a.indexOf('/'))) throw new PatchError(`${w}: ${r.name} is already in that subregion`);
            const sub = needSub(raw, area, w);
            const to = moveRoom(raw, a, area, op.id, w, out, world);
            return `${r.name} moved to ${sub.name ?? area}${split(to)[2] !== split(a)[2] ? ` (as ${split(to)[2]})` : ''}`;
        }
        case 'move_area': return moveAreaOp(raw, op, w, out, world);
        case 'create_place': {
            const sub = needSub(raw, str(op.area), w);
            if (op.story === true) for (const e of (Array.isArray(op.exits) ? op.exits : [])) {
                const t = isObj(e) && typeof e.to === 'string' ? getRoom(raw, e.to) : null;
                if (t && !expandableOf(raw, e.to, world)) throw new PatchError(`${w}: ${t.name} can't be expanded ("expandable" is false for it or its area)`);
            }
            const a = createPlace(raw, str(op.area), op, w, out, true), r = getRoom(raw, a);
            (out.created ??= new Set()).add(a);
            const ex = op.exits?.length === 1 ? op.exits[0] : null;
            if (op.story === true && ex) return `${getRoom(raw, ex.to)?.name ?? ex.to} ${ex.return_direction}: leads to ${r.name} (a newly found room)`;
            return `${r.name}: new place in ${sub.name ?? op.area}`;
        }
        case 'create_subregion': {
            const rid = str(op.region);
            if (!isObj(raw[rid])) throw new PatchError(`${w}: "region" ${JSON.stringify(op.region)} is not a region`);
            const sid = createSub(raw, rid, op, w, out, true);
            return `${raw[rid].subregions[sid].name}: new subregion in ${raw[rid].name ?? rid}`;
        }
        case 'create_region': {
            const name = needText(op, w, 'name', MAX_PATCH_NAME), rid = newId(op.id, name, w);
            if (has(raw, rid)) throw clashError(w, 'region', rid, suggestId(new Set(Object.keys(raw)), rid));
            raw[rid] = { name, ...(str(op.lore) ? { lore: needText(op, w, 'lore') } : {}), start: '', subregions: {} };
            if (!isObj(op.subregion)) throw new PatchError(`${w}: a new region needs its first "subregion" (with a "place")`);
            try {
                const sid = createSub(raw, rid, op.subregion, `${w}, subregion`, out, false);
                raw[rid].start = `${sid}/${raw[rid].subregions[sid].entrance}`;
            } catch (e) { delete raw[rid]; throw e; }
            out.touched.push(rid);
            return `${name}: new region`;
        }
        case 'remove_area': return removeAreaOp(raw, op, w, out, world);
    }
    throw new PatchError(`${w}: unknown op`);
}

export const ENUMS = { exposure: ['outdoor', 'sheltered', 'enclosed', 'fixed'], insulation: ['drafty', 'normal', 'cozy'], type: ['portal', 'open'], sight: ['clear', 'partial', 'none'], sound: ['clear', 'partial', 'none'],
    closed_sight: ['clear', 'partial', 'none'], closed_sound: ['clear', 'partial', 'none'] };
const BOOL_KEYS = new Set(['inherit_region_lore', 'inherit_subregion_lore', 'inherit_lore', 'label_rooms', 'stays_open', 'hidden', 'obscured',
    'openable', 'locked', 'starts_open']);
const NUM_KEYS = new Set(['indoor_temp', 'temp_offset']);
/** One form value checked (enums, booleans, numbers, short text); null passes (it means "drop it"). */
function fieldValue(k, v, w) {
    if (v === null) return null;
    if (BOOL_KEYS.has(k)) { if (typeof v !== 'boolean') throw new PatchError(`${w}: "${k}" must be true or false`); return v; }
    if (NUM_KEYS.has(k)) { const n = typeof v === 'number' ? v : Number(str(String(v))); if (!Number.isFinite(n) || str(String(v)) === '') throw new PatchError(`${w}: "${k}" must be a number`); return n; }
    if (ENUMS[k] && !ENUMS[k].includes(v)) throw new PatchError(`${w}: "${k}" must be one of ${ENUMS[k].join(', ')}`);
    if (typeof v !== 'string' || !v.trim()) throw new PatchError(`${w}: "${k}" must be a non-empty string`);
    if (k === 'lore') { if (v.length > MAX_TEXT) throw new PatchError(`${w}: "lore" is too long (at most ${MAX_TEXT} characters)`); return v.trim(); }
    if (v.length > 400) throw new PatchError(`${w}: "${k}" is too long (at most 400 characters)`);
    return v.trim();
}
const showVal = v => (v === null ? 'inherited' : typeof v === 'string' ? JSON.stringify(v) : String(v));
function fieldsOp(raw, op, w, out) {
    const t = str(op.target), p = split(t), [rid, sid] = p ?? t.split(':');
    const kind = p ? 'room' : sid ? 'subregion' : 'region';
    const obj = p ? getRoom(raw, t) : sid ? raw[rid]?.subregions?.[sid] : raw[rid];
    if (!isObj(obj) || !rid) throw new PatchError(`${w}: "target" ${JSON.stringify(op.target)} is not a room, subregion ("region:subregion") or region ("region")`);
    if (!isObj(op.fields) || !Object.keys(op.fields).length) throw new PatchError(`${w}: "fields" must be an object with at least one setting`);
    const bits = [];
    for (const [k, v0] of Object.entries(op.fields)) {
        if (!FIELD_KEYS[kind].includes(k)) throw new PatchError(`${w}: a ${kind} has no setting "${k}" here (allowed: ${FIELD_KEYS[kind].join(', ')})`);
        let v = fieldValue(k, v0, w);
        if (k === 'entrance' && v !== null) {
            const rel = kind === 'subregion' ? v.split('/').pop() : v.includes(':') ? v.split(':')[1] : v;
            const ok = kind === 'subregion' ? has(obj.locations, rel) : (() => { const [s, l] = rel.split('/'); return isObj(obj.subregions?.[s]) && (l === undefined || has(obj.subregions[s].locations, l)); })();
            if (!ok) throw new PatchError(`${w}: "entrance" ${JSON.stringify(v)} is not a room in ${obj.name ?? t}`);
            v = rel;
        }
        if (v === null) delete obj[k]; else obj[k] = v;
        bits.push(`${k} ${showVal(v)}`);
    }
    out.touched.push(t);
    return `${obj.name ?? t}: ${bits.join(', ')}`;
}
function barrierValue(b, w) {
    if (b === null) return null;
    if (!isObj(b)) throw new PatchError(`${w}: "barrier" must be an object (the door) or null (no door)`);
    const o = {};
    for (const [k, v] of Object.entries(b)) {
        if (!['closed_sight', 'closed_sound', 'openable', 'locked', 'starts_open', 'stays_open', 'barred_from'].includes(k)) throw new PatchError(`${w}: a door has no setting "${k}"`);
        if (v === null || v === undefined) continue;
        if (k === 'barred_from') { if (!['this_side', 'other_side'].includes(v)) throw new PatchError(`${w}: "barred_from" must be "this_side" or "other_side" (or null for no bar)`); o[k] = v; continue; }
        o[k] = k === 'stays_open' ? (typeof v === 'boolean' ? v : (() => { throw new PatchError(`${w}: "stays_open" must be true or false`); })()) : fieldValue(k, v, w);
    }
    return o;
}
function setExitOp(raw, op, w, out) {
    const a = str(op.loc), { r, ex, back, backRoom } = findExit(raw, a, op.direction, w);
    if (!isObj(op.fields) || !Object.keys(op.fields).length) throw new PatchError(`${w}: "fields" must be an object with at least one setting`);
    const label = `${r.name} ${ex.direction} exit${backRoom ? ` (to ${backRoom.name})` : ''}`, bits = [];
    for (const [k, v0] of Object.entries(op.fields)) {
        if (k === 'barrier') {
            const b = barrierValue(v0, w);
            if (back) delete back.barrier;
            if (b === null) delete ex.barrier; else ex.barrier = b;
            bits.push(b === null ? 'no door (both sides)' : 'door changed (both sides)');
        } else if (k === 'travel_time') {
            const t = needText({ t: v0 }, w, 't', 20);
            try { parseDuration(t); } catch (err) { throw new PatchError(`${w}: "travel_time": ${err.message}`); }
            ex.travel_time = t; if (back) back.travel_time = t;
            bits.push(`travel time ${t} (both ways)`);
        } else if (EXIT_SIDE_KEYS.includes(k)) {
            const v = k === 'description' && v0 !== null ? needText({ t: v0 }, w, 't', 400) : fieldValue(k, v0, w);
            if (k === 'direction') {
                if (v === null) throw new PatchError(`${w}: an exit needs a "direction"`);
                if (r.exits.some(e => e !== ex && isObj(e) && lc(e.direction) === lc(v))) throw new PatchError(`${w}: ${r.name} already has an exit ${JSON.stringify(v)}`);
            }
            if (v === null) delete ex[k]; else ex[k] = v;
            bits.push(`${k} ${showVal(v)}`);
        } else throw new PatchError(`${w}: an exit has no setting "${k}" here (allowed: ${[...EXIT_SIDE_KEYS, ...EXIT_SHARED_KEYS].join(', ')})`);
    }
    out.touched.push(a, ex.to);
    return `${label}: ${bits.join(', ')}`;
}
/**
 * An add_exit that repeats a door pair made earlier in this patch (create_place already joins its new room): dropped,
 * with its extra fields (description, door, travel_time) merged in where the made exit has none of its own. null when not a repeat.
 */
function dupExit(raw, op, a, r, to, t, dir, back, out) {
    if (!out.created || !(out.created.has(a) || out.created.has(to))) return null;
    const fw = (r.exits ?? []).find(e => isObj(e) && e.to === to), bw = (t.exits ?? []).find(e => isObj(e) && e.to === a);
    if (!fw || (back && !bw)) return null;
    const desc = str(op.description).slice(0, 400), rdesc = str(op.return_description).slice(0, 400);
    const plain = d => !d || /^The way (back )?to .*\.$/.test(d);
    if (desc && plain(fw.description)) fw.description = desc;
    if (rdesc && bw && plain(bw.description)) bw.description = rdesc;
    if (op.door === true && !fw.barrier) fw.barrier = {};
    if (str(op.travel_time) && !fw.travel_time) { try { parseDuration(str(op.travel_time)); fw.travel_time = str(op.travel_time); if (bw) bw.travel_time ??= fw.travel_time; } catch { /* keep the made one */ } }
    out.touched.push(a, to);
    return `${r.name} ${fw.direction}: same exit as the new room's, merged`;
}
function addExitOp(raw, op, w, out) {
    const a = str(op.loc), r = needRoom(raw, a, w), to = str(op.to), t = needRoom(raw, to, w, 'to');
    if (to === a) throw new PatchError(`${w}: an exit can't lead back into the same room`);
    const dir = needText(op, w, 'direction', 60), back = str(op.return_direction);
    if (back.length > 60) throw new PatchError(`${w}: "return_direction" is too long (at most 60 characters)`);
    if (!back && op.one_way !== true) throw new PatchError(`${w}: the way back needs a "return_direction" (or one_way: true)`);
    const dup = dupExit(raw, op, a, r, to, t, dir, back, out);
    if (dup) return dup;
    if ((r.exits ?? []).some(e => isObj(e) && lc(e.direction) === lc(dir))) throw new PatchError(`${w}: ${r.name} already has an exit ${JSON.stringify(dir)}`);
    if ((r.exits ?? []).some(e => isObj(e) && e.to === to)) throw new PatchError(`${w}: ${r.name} already has an exit to ${t.name}`);
    if (back && (t.exits ?? []).some(e => isObj(e) && lc(e.direction) === lc(back))) throw new PatchError(`${w}: ${t.name} already has an exit ${JSON.stringify(back)}`);
    if (back && (t.exits ?? []).some(e => isObj(e) && e.to === a)) throw new PatchError(`${w}: ${t.name} already has an exit to ${r.name}`);
    const time = str(op.travel_time) || '30s';
    try { parseDuration(time); } catch (err) { throw new PatchError(`${w}: "travel_time": ${err.message}`); }
    const ex = { direction: dir, to, travel_time: time, description: str(op.description).slice(0, 400) || `The way to ${t.name}.` };
    if (op.door === true) ex.barrier = {};
    if (!back) ex.one_way = true;
    r.exits = [...(Array.isArray(r.exits) ? r.exits : []), ex];
    if (back) t.exits = [...(Array.isArray(t.exits) ? t.exits : []), { direction: back, to: a, travel_time: time, description: str(op.return_description).slice(0, 400) || `The way back to ${r.name}.` }];
    out.touched.push(a, to);
    return `${r.name} ${dir}: new exit to ${t.name}${back ? ` (back: ${back})` : ' (one way)'}`;
}

/** "expandable" for a room: its own setting, else its subregion's, else its region's, else world.json's; default true. */
export function expandableOf(raw, address, world = null) {
    const p = split(address); if (!p) return true;
    const reg = raw[p[0]], sub = reg?.subregions?.[p[1]], room = sub?.locations?.[p[2]];
    for (const o of [room, sub, reg, world]) if (isObj(o) && typeof o.expandable === 'boolean') return o.expandable;
    return true;
}
function expandValue(v, w) {
    if (v === true || v === false || v === null || v === undefined) return v ?? null;
    const t = String(v).trim().toLowerCase();
    if (t === 'true' || t === 'yes') return true;
    if (t === 'false' || t === 'no') return false;
    if (t === '' || t === 'null' || t === 'inherit') return null;
    throw new PatchError(`${w}: "value" must be true, false or inherit`);
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
    const own = isObj(ex.barrier) ? ex.barrier : isObj(back?.barrier) ? flipBar(back.barrier) : {}; // moved to this side: barred_from flips
    const clearBack = () => { if (back) delete back.barrier; };
    if (op.op === 'break_exit') {
        delete ex.barrier; clearBack();
        if (ex.hidden || ex.obscured) ex.view = 'open';
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
        if (!Object.keys(reg.subregions).length) continue; // emptied: dropEmpty deletes the region
        const valid = rel => { const [s, l] = String(rel).split('/'); return isObj(reg.subregions[s]) && (l === undefined || has(reg.subregions[s].locations, l)); };
        const fallback = () => { const t = split(target); if (t && t[0] === rid) return `${t[1]}/${t[2]}`; const [s, sub] = Object.entries(reg.subregions)[0]; return `${s}/${Object.keys(sub.locations)[0]}`; };
        if (typeof reg.start === 'string' && !valid(reg.start)) reg.start = fallback();
        if (typeof reg.entrance === 'string' && !valid(reg.entrance)) delete reg.entrance;
    }
}
const roomsIn = (raw, rid) => Object.values(raw[rid]?.subregions ?? {}).reduce((n, s) => n + Object.keys(s?.locations ?? {}).length, 0);

function removeOp(raw, op, w, out, world = null) {
    const a = str(op.loc), r = needRoom(raw, a, w), [rid, sid, lid] = split(a);
    const subName = raw[rid].subregions[sid].name ?? sid, regName = raw[rid].name ?? rid;
    const lastSub = Object.keys(raw[rid].subregions[sid].locations).length <= 1, lastReg = roomsIn(raw, rid) <= 1;
    if (lastReg) canDropRegion(raw, rid, world, w, `remove ${r.name}, the last place of ${regName}`);
    const near = nearest(raw, new Set([a]), r.exits);
    removeRooms(raw, [a], near, out);
    dropEmpty(raw);
    return `${r.name} removed (anyone there ends up in ${nameOf(raw, near)})${lastReg ? `; ${regName} deleted with it` : lastSub ? `; ${subName} deleted with it` : ''}`;
}
/** The place left over that is closest to the removed ones: through their exits first (same region preferred), else any. */
function nearest(raw, gone, exits = null) {
    const ex = exits ?? [...gone].flatMap(a => getRoom(raw, a)?.exits ?? []);
    const tos = ex.filter(isObj).map(e => e.to).filter(t => !gone.has(t) && getRoom(raw, t));
    const rids = new Set([...gone].map(a => split(a)[0]));
    const all = [...eachRoom(raw)].map(x => x[0]).filter(x => !gone.has(x));
    return tos.find(t => rids.has(split(t)[0])) ?? all.find(t => rids.has(split(t)[0]) && [...gone].some(g => g.slice(0, g.indexOf('/')) === t.slice(0, t.indexOf('/'))))
        ?? all.find(t => rids.has(split(t)[0])) ?? tos[0] ?? all[0] ?? null;
}
function removeRooms(raw, addrs, near, out) {
    if (!near) throw new PatchError('nothing would be left of the world');
    const gone = new Set(addrs);
    for (const a of addrs) { const [r, s, l] = split(a); delete raw[r].subregions[s].locations[l]; }
    rewire(raw, gone, null);
    fixEntrances(raw, gone, near);
    for (const a of addrs) relocateTo(out, a, near);
    out.touched.push(...addrs);
}
/** A region may go only if another one is left and it isn't the world's starting region. */
function canDropRegion(raw, rid, world, w, what) {
    if (Object.keys(raw).length <= 1) throw new PatchError(`${w}: can't ${what}: it is the world's only region`);
    if (isObj(world) && world.start_region === rid) throw new PatchError(`${w}: can't ${what}: it is the world's starting region`);
}
/** Regions emptied by a removal or move go too (their subregions already went in fixEntrances). */
function dropEmpty(raw) {
    for (const [rid, reg] of Object.entries(raw)) if (isObj(reg) && isObj(reg.subregions) && !Object.keys(reg.subregions).length) delete raw[rid];
}
function needSub(raw, area, w) {
    const [rid, sid] = String(area ?? '').split(':'), sub = raw[rid]?.subregions?.[sid];
    if (!sid || !isObj(sub)) throw new PatchError(`${w}: "area" ${JSON.stringify(area)} is not a subregion ("region:subregion")`);
    return sub;
}
/** A free id in `taken`: id itself, else "<prefix>_<id>" (prefix: where it comes from), else id_2, id_3... */
export function suggestId(taken, id, prefix = '') {
    if (!taken.has(id)) return id;
    if (prefix && !taken.has(`${prefix}_${id}`)) return `${prefix}_${id}`;
    let n = 2;
    while (taken.has(`${id}_${n}`)) n++;
    return `${id}_${n}`;
}
/** Whether `id` is free for a place in subregion `container` ("region:sub"), a subregion in region `container`, or a region. */
export function idClash(raw, kind, container, id, prefix = '') {
    const taken = new Set(kind === 'room' ? Object.keys(needSub(raw, container, 'id check').locations ?? {}) : kind === 'subregion' ? Object.keys(raw[container]?.subregions ?? {}) : Object.keys(raw));
    return taken.has(id) ? { id, taken: true, suggest: suggestId(taken, id, prefix) } : { id, taken: false, suggest: id };
}
function clashError(w, kind, id, suggest) {
    const e = new PatchError(`${w}: a ${kind === 'room' ? 'place' : kind} with id "${id}" is already there; pick another id (suggested: "${suggest}")`);
    e.clash = { kind, id, suggest };
    return e;
}
function newId(id, name, w) {
    const v = str(id) ? slugId(id) : newRoomId(name);
    if (!SLUG.test(v)) throw new PatchError(`${w}: an id needs letters or digits (lowercase, "_" between words)`);
    return v;
}
/** Every exit "to" / view that names an old address points at its new one. */
function readdress(raw, map) {
    for (const [, loc] of eachRoom(raw)) {
        if (Array.isArray(loc.exits)) for (const e of loc.exits) if (isObj(e) && has(map, e.to)) e.to = map[e.to];
        if (Array.isArray(loc.views)) loc.views = loc.views.map(v => (has(map, v) ? map[v] : v));
    }
}
function moveRoom(raw, a, area, id, w, out, world = null) {
    const [rid, sid, lid] = split(a), [arid, asid] = area.split(':'), dest = raw[arid].subregions[asid];
    const nid = str(id) ? newId(id, '', w) : lid, to = `${arid}:${asid}/${nid}`;
    if (has(dest.locations ?? {}, nid)) throw clashError(w, 'room', nid, suggestId(new Set(Object.keys(dest.locations)), nid, sid));
    if (arid !== rid && roomsIn(raw, rid) <= 1) canDropRegion(raw, rid, world, w, `move ${getRoom(raw, a).name} out, the last place of ${raw[rid].name ?? rid}`);
    const room = getRoom(raw, a);
    delete raw[rid].subregions[sid].locations[lid];
    (dest.locations ??= {})[nid] = room;
    delete room.pos;
    readdress(raw, { [a]: to });
    fixEntrances(raw, new Set([a]), to);
    dropEmpty(raw);
    relocateTo(out, a, to);
    out.touched.push(a, to);
    return to;
}
function moveAreaOp(raw, op, w, out, world = null) {
    const area = str(op.area), [rid, sid] = area.split(':'), sub = needSub(raw, area, w), dr = str(op.region);
    if (!isObj(raw[dr])) throw new PatchError(`${w}: "region" ${JSON.stringify(op.region)} is not a region`);
    if (dr === rid) throw new PatchError(`${w}: ${sub.name ?? sid} is already in that region`);
    const nid = moveSub(raw, rid, sid, dr, op.id, w, out, world);
    return `${sub.name ?? sid} moved to ${raw[dr].name ?? dr}${nid !== sid ? ` (as ${nid})` : ''}`;
}
function moveSub(raw, rid, sid, dr, id, w, out, world) {
    const nid = str(id) ? newId(id, '', w) : sid, sub = raw[rid].subregions[sid];
    if (has(raw[dr].subregions, nid)) throw clashError(w, 'subregion', nid, suggestId(new Set(Object.keys(raw[dr].subregions)), nid, rid));
    if (Object.keys(raw[rid].subregions).length <= 1) canDropRegion(raw, rid, world, w, `move ${sub.name ?? sid} out, the last subregion of ${raw[rid].name ?? rid}`);
    const map = Object.fromEntries(Object.keys(sub.locations ?? {}).map(l => [`${rid}:${sid}/${l}`, `${dr}:${nid}/${l}`]));
    delete raw[rid].subregions[sid];
    raw[dr].subregions[nid] = sub;
    readdress(raw, map);
    const reg = raw[rid];
    if (typeof reg.entrance === 'string' && reg.entrance.split('/')[0] === sid) delete reg.entrance;
    const first = Object.values(map)[0];
    fixEntrances(raw, new Set(Object.keys(map)), first);
    dropEmpty(raw);
    for (const [k, v] of Object.entries(map)) relocateTo(out, k, v);
    out.touched.push(`${rid}:${sid}`, `${dr}:${nid}`, ...Object.keys(map), ...Object.values(map));
    return nid;
}
function removeAreaOp(raw, op, w, out, world = null) {
    const area = str(op.area), contents = str(op.contents), ids = isObj(op.ids) ? op.ids : {};
    if (!['delete', 'move'].includes(contents)) throw new PatchError(`${w}: "contents" must be "delete" or "move"`);
    const into = str(op.into);
    if (area.includes(':')) {
        const [rid, sid] = area.split(':'), sub = needSub(raw, area, w), name = sub.name ?? sid, regName = raw[rid].name ?? rid;
        const lastSub = Object.keys(raw[rid].subregions).length <= 1;
        const addrs = Object.keys(sub.locations ?? {}).map(l => `${rid}:${sid}/${l}`);
        if (contents === 'move') {
            if (into === area) throw new PatchError(`${w}: can't move ${name}'s places into itself`);
            const dest = needSub(raw, into, w), [irid] = into.split(':');
            if (lastSub && irid !== rid) canDropRegion(raw, rid, world, w, `delete ${name}, the last subregion of ${regName}`);
            for (const a of addrs) moveRoom(raw, a, into, ids[split(a)[2]], w, out, world);
            if (isObj(raw[rid]?.subregions?.[sid])) { delete raw[rid].subregions[sid]; fixEntrances(raw, new Set(), into); dropEmpty(raw); }
            out.touched.push(area);
            return `${name} deleted; its ${addrs.length} place${addrs.length === 1 ? '' : 's'} moved to ${dest.name ?? into}`;
        }
        if (lastSub) canDropRegion(raw, rid, world, w, `delete ${name}, the last subregion of ${regName}`);
        const near = nearest(raw, new Set(addrs));
        removeRooms(raw, addrs, near, out);
        if (isObj(raw[rid]?.subregions?.[sid])) delete raw[rid].subregions[sid];
        fixEntrances(raw, new Set(), near); dropEmpty(raw);
        out.touched.push(area);
        return `${name} deleted with its ${addrs.length} place${addrs.length === 1 ? '' : 's'} (anyone there ends up in ${nameOf(raw, near)})${lastSub ? `; ${regName} deleted with it` : ''}`;
    }
    const rid = area, reg = raw[rid];
    if (!isObj(reg)) throw new PatchError(`${w}: "area" ${JSON.stringify(op.area)} is not a region or subregion`);
    canDropRegion(raw, rid, world, w, `delete ${reg.name ?? rid}`);
    const sids = Object.keys(reg.subregions ?? {});
    if (contents === 'move') {
        if (!isObj(raw[into]) || into === rid) throw new PatchError(`${w}: "into" must be another region`);
        for (const s of sids) moveSub(raw, rid, s, into, ids[s], w, out, world);
        delete raw[rid];
        out.touched.push(rid);
        return `${reg.name ?? rid} deleted; its ${sids.length} subregion${sids.length === 1 ? '' : 's'} moved to ${raw[into].name ?? into}`;
    }
    const addrs = [...eachRoom(raw)].filter(x => x[2] === rid).map(x => x[0]);
    const near = nearest(raw, new Set(addrs));
    removeRooms(raw, addrs, near, out);
    delete raw[rid];
    out.touched.push(rid);
    return `${reg.name ?? rid} deleted with everything in it (anyone there ends up in ${nameOf(raw, near)})`;
}
function createPlace(raw, area, p, w, out, needExit) {
    if (!isObj(p)) throw new PatchError(`${w}: a new place needs a "name" and "description"`);
    const sub = needSub(raw, area, w), name = needText(p, w, 'name', MAX_PATCH_NAME), description = needText(p, w, 'description');
    const id = newId(p.id, name, w);
    if (has(sub.locations ?? {}, id)) throw clashError(w, 'room', id, suggestId(new Set(Object.keys(sub.locations)), id));
    const exits = Array.isArray(p.exits) ? p.exits.filter(e => isObj(e) && (str(e.to) || str(e.direction))) : [];
    if (needExit && !exits.length) throw new PatchError(`${w}: a new place needs at least one exit to an existing place`);
    const a = `${area}/${id}`;
    (sub.locations ??= {})[id] = { name, description, exits: [] };
    exits.forEach((e, i) => addExitOp(raw, { ...e, loc: a }, `${w}, exit #${i + 1}`, out));
    out.touched.push(a);
    (out.made ??= []).push({ address: a, id, name, ref: str(p.ref).toLowerCase() });
    return a;
}
function createSub(raw, rid, p, w, out, needExit) {
    if (!isObj(p)) throw new PatchError(`${w}: a new subregion needs a "name"`);
    const name = needText(p, w, 'name', MAX_PATCH_NAME), sid = newId(p.id, name, w);
    if (has(raw[rid].subregions, sid)) throw clashError(w, 'subregion', sid, suggestId(new Set(Object.keys(raw[rid].subregions)), sid));
    raw[rid].subregions[sid] = { name, ...(str(p.lore) ? { lore: needText(p, w, 'lore') } : {}), locations: {} };
    try {
        const a = createPlace(raw, `${rid}:${sid}`, isObj(p.place) && str(p.ref) && !str(p.place.ref) ? { ...p.place, ref: p.ref } : p.place, `${w}, place`, out, needExit);
        raw[rid].subregions[sid].entrance = split(a)[2];
    } catch (e) { delete raw[rid].subregions[sid]; throw e; }
    out.touched.push(`${rid}:${sid}`);
    return sid;
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
        // A brand-new room's id comes from its name (the model's "id" is ignored); a moved room keeps its id. Taken ids get _2, _3...
        const want = into ? split(into)[2] : newRoomId(str(op.name));
        if (!SLUG.test(want)) throw new PatchError(`${w}: a new place needs a "name" with letters or digits`);
        target = freeAddress(raw, `${arid}:${asid}`, want, locs);
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

/**
 * The patch call's prompt. `c` is /patch/context's answer: rooms (full JSON of the changed places), areas, outline,
 * and neighbors (one exit beyond the change, compact). Neighbors may get proposals too; leaving them alone is fine.
 */
export function patchPrompt(c, { story = '', what = '', err = '', range = '' } = {}) {
    const outline = (c.outline ?? []).map(o => `${o.address} = ${o.name} [${o.area_name}]; exits: ${(o.exits ?? []).map(x => `${x.direction}->${x.to}${x.door ? ` (${x.door})` : ''}`).join(', ') || 'none'}`).join('\n');
    const nb = (c.neighbors ?? []).map(n => `${n.address} = ${n.name}: ${n.description ?? ''} | exits: ${(n.exits ?? []).map(x => `${x.direction}->${x.to}${x.description ? ` "${x.description}"` : ''}`).join('; ') || 'none'}`).join('\n');
    const ments = (c.mentions ?? []).map(m => `${m.where}${m.field ? `.${m.field}` : ''}: ${m.text}`).join('\n');
    return P('change.patch', { rooms: JSON.stringify(c.rooms ?? {}, null, 1),
        areas: Object.keys(c.areas ?? {}).length ? P('change.patch_areas', { areas: JSON.stringify(c.areas) }) + '\n' : '',
        neighbors: nb ? P('change.patch_neighbors', { neighbors: nb }) + '\n' : '',
        mentions: (c.mentions ?? []).length ? P('change.patch_mentions', { mentions: ments }) + '\n' : '',
        outline, range, story, what, retry: err ? P('change.patch_retry', { error: err }) + '\n' : '' });
}

/** Rooms one exit away from any affected room (either direction), outside the affected set. `w` is a built World. */
export function neighborsOf(w, affected) {
    const aff = new Set(affected), out = new Set();
    for (const l of w.locations.values()) for (const x of l.exits) {
        if (aff.has(l.address) && !aff.has(x.to)) out.add(x.to);
        if (aff.has(x.to) && !aff.has(l.address)) out.add(l.address);
    }
    return [...out].map(a => w.get(a)).filter(Boolean).slice(0, 24).map(l => ({ address: l.address, name: l.name, description: l.description ?? '',
        exits: l.exits.map(x => ({ direction: x.direction, to: x.to, ...(x.description ? { description: x.description } : {}) })) }));
}

/**
 * Every world text that names one of `names` (the changed places' current names), outside the changed places:
 * room descriptions and exit texts, region/subregion notes, and any other string field (NPCs etc.). Compact:
 * [{where, field, text}], where = a room address, an area id, or an area id + a field path.
 */
export function mentionsOf(raw, names, skip = new Set()) {
    const want = [...new Set(names.map(n => str(n)).filter(n => n.length >= 3))];
    if (!want.length) return [];
    const re = new RegExp(want.map(n => n.replace(/^the\s+/i, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'i');
    const out = [];
    const walk = (v, where, path) => {
        if (out.length >= 30) return;
        if (typeof v === 'string') { if (re.test(v)) out.push({ where, field: path, text: v.length > 300 ? `${v.slice(0, 300)}…` : v }); return; }
        if (Array.isArray(v)) { v.forEach((x, i) => walk(x, where, `${path}[${isObj(x) && x.direction ? x.direction : i}]`)); return; }
        if (isObj(v)) for (const [k, x] of Object.entries(v)) if (k !== 'name' && k !== 'to' && k !== 'subregions' && k !== 'locations') walk(x, where, path ? `${path}.${k}` : k);
    };
    for (const [rid, r] of Object.entries(raw)) {
        if (!isObj(r)) continue;
        if (!skip.has(rid)) walk(r, rid, '');
        for (const [sid, sub] of Object.entries(r.subregions ?? {})) {
            if (!isObj(sub)) continue;
            const area = `${rid}:${sid}`;
            if (!skip.has(area)) walk(sub, area, '');
            for (const [lid, l] of Object.entries(sub.locations ?? {})) { const a = `${area}/${lid}`; if (!skip.has(a) && !skip.has(area)) walk(l, a, ''); }
        }
    }
    return out;
}

/**
 * What the model is told about each op, generated into the change call's prompt from OPS, so anything the editor can do
 * the model can propose. ADDR is a room address, AREA a subregion ("region:sub") or region ("region"). Ops the model
 * never writes itself have no entry. New ops in OPS need a line here (a test checks).
 */
export const OP_DOCS = {
    set_description: '{"op":"set_description","loc":ADDR,"text":"..."}',
    append_description: '{"op":"append_description","loc":ADDR,"text":"..."}',
    set_name: '{"op":"set_name","loc":ADDR,"text":"New display name"} (the address stays the same)',
    set_lore: '{"op":"set_lore","area":AREA,"text":"..."}',
    append_lore: '{"op":"append_lore","area":AREA,"text":"..."}',
    update_area: '{"op":"update_area","area":AREA,"name":"New display name","lore":"..."} (rename a whole building/area and/or rewrite its lore; give name, lore or both)',
    block_exit: '{"op":"block_exit","loc":ADDR,"direction":"exit name"} (door state, both sides)',
    open_exit: '{"op":"open_exit","loc":ADDR,"direction":"exit name"}',
    lock_exit: '{"op":"lock_exit","loc":ADDR,"direction":"exit name"}',
    unlock_exit: '{"op":"unlock_exit","loc":ADDR,"direction":"exit name"}',
    break_exit: '{"op":"break_exit","loc":ADDR,"direction":"exit name"} (the door is gone; the way stays)',
    remove_exit: '{"op":"remove_exit","loc":ADDR,"direction":"exit name"} (both sides: the way is gone)',
    set_exit_description: '{"op":"set_exit_description","loc":ADDR,"direction":"exit name","text":"..."} (that side\'s exit text only)',
    set_travel_time: '{"op":"set_travel_time","loc":ADDR,"direction":"exit name","time":"10m"} (both ways)',
    remove_location: '{"op":"remove_location","loc":ADDR} (the place is gone)',
    merge: '{"op":"merge","locs":[ADDR,...],"into":ADDR (one of locs, kept)} or {"op":"merge","locs":[ADDR,...],"name":"...","description":"..."} (existing rooms become one; never for making new rooms)',
    set_expandable: '{"op":"set_expandable","target":ADDR or AREA,"value":true|false|"inherit"} (whether new rooms can be found there)',
    set_fields: '{"op":"set_fields","target":ADDR or AREA,"fields":{"exposure":"outdoor|sheltered|enclosed|fixed","insulation":"drafty|normal|cozy","indoor_temp":20,...}} (plain settings; null drops one)',
    set_exit: '{"op":"set_exit","loc":ADDR,"direction":"exit name","fields":{...}} (per side: direction, description, type, sight, sound, traversal, hidden, obscured; shared by the pair: travel_time, barrier (the door object, or null for none))',
    add_exit: '{"op":"add_exit","loc":ADDR,"direction":"exit name","to":ADDR,"return_direction":"exit name back","door":true|false} (a new way between two rooms that already exist before this patch; not for a room made by create_place, whose exits already join it)',
    move_location: '{"op":"move_location","loc":ADDR,"area":"region:sub"} (a room moves to another subregion, keeping its exits)',
    move_area: '{"op":"move_area","area":"region:sub","region":"region"} (a subregion moves to another region)',
    create_place: '{"op":"create_place","name":"...","description":"...","exits":[{"to":ADDR,"direction":"exit name from the new place","return_direction":"exit name from ADDR to the new place","door":true|false}]} (a NEW room; each of its exits already makes the door pair both ways, so never add a separate add_exit for it; the engine makes its id and puts it in the area of its first exit\'s room unless you give "area"; several create_place ops make several rooms, e.g. three rooms off a hub, each with its own exit names; give it "ref":"label" and later ops in the same patch point at it with "new:label" wherever an address goes, e.g. {"op":"set_fields","target":"new:portal_room",...} or an add_exit "to":"new:portal_room"; never guess the engine-made address)',
    create_subregion: '{"op":"create_subregion","region":"region","name":"...","lore":"...","place":{"name":"...","description":"...","exits":[...as create_place]}} (a new building/area with its first room; "ref":"label" lets later ops use "new:label" for that room)',
    create_region: '{"op":"create_region","name":"...","lore":"...","subregion":{"name":"...","place":{...}}} (a whole new region)',
    remove_area: '{"op":"remove_area","area":AREA,"contents":"delete"|"move","into":AREA} (delete a subregion or region, or move its contents into another)',
};
/** The op list for the change call's prompt, one line per op in OPS (in that order). */
export const opDocs = () => OPS.filter(o => OP_DOCS[o]).map(o => OP_DOCS[o]).join('\n');
/**
 * The model's answer to the change call, normalized: {ops} to preview, {nothing: true}, or {cant: "why"} when the story
 * changed the map in a way no op can express (shown to the player plainly instead of forcing a wrong edit). Ops made by
 * the story get story: true on create_place (engine-made id, "expandable" respected) and lose any id the model wrote.
 */
export function readChangeAnswer(ans) {
    if (!isObj(ans)) return null;
    const cant = str(ans.cant ?? ans.cannot ?? ans.cant_express);
    if (cant) return { cant: cant.slice(0, 300) };
    if (!Array.isArray(ans.ops)) return null;
    if (!ans.ops.length) return { nothing: true };
    const ops = ans.ops.map(o => {
        if (!isObj(o)) return o;
        if (o.op === 'create_place') { const { id, ...rest } = o; return { ...rest, story: true }; }
        return o;
    });
    return { ops };
}

/** A kept change's one-line text for the Changes tab: " · note: summary", with repeats dropped (a note that is just one of
 *  the summary lines, and the same summary line twice). */
export function changeText(c) {
    const norm = t => String(t ?? '').trim().toLowerCase();
    const sum = [];
    for (const t of c?.summary ?? []) if (t && !sum.some(x => norm(x) === norm(t))) sum.push(t);
    const note = c?.note && !sum.some(t => norm(t) === norm(c.note) || norm(t).endsWith(`: ${norm(c.note)}`) || norm(t).includes(norm(c.note))) ? c.note : '';
    return `${note ? ` · ${note}` : ''}: ${sum.join('; ') || c?.note || ''}${c?.off ? ' (turned off)' : ''}`;
}
