// Per-chat world changes, applied to the plain JSON of a world (the hand-written format).
//
// A change is an object with a "type". Known types:
//   {"type": "add_exit", "from": "region:sub/loc", "direction": "north", "to": "region:sub/loc", "description"?: str}
//   {"type": "remove_exit", "from": "region:sub/loc", "direction": "north"}
//   {"type": "dig", "from": A, "direction": "north", "to": B, "description"?: str,
//    "return_direction": "south", "return_description"?: str}   two-way: exits A->B and B->A (neither may exist yet)
//   {"type": "add_room", "address": "region:sub/new_id", "name": str, "description": str, "from"?: A}
//       a new room in an existing subregion (no exits of its own; dig to/from it). "from" is informational.
//   {"type": "open_door" | "close_door", "from": A, "direction": "out", ...}   door state: replayed by the client;
//       checked here (the exit must exist) but never written into a saved world
//   {"type": "view_link", "from": A, "to": B}   what A's window (no exit) looks out on; saved into A's "views"
// The extension stamps changes on chat messages; the server applies them per request (/move, /travel) and when
// rendering a new world folder. Anything else is rejected, so new types must be added here deliberately.
import { WorldError, has, isObj, plen, repr, strip } from './world.mjs';

export const CHANGE_TYPES = ['add_exit', 'remove_exit', 'dig', 'add_room', 'open_door', 'close_door', 'view_link'];
export const MAX_NAME = 60, MAX_DIRECTION = 30, MAX_DESCRIPTION = 400;

const get = (o, k) => (has(o, k) ? o[k] : undefined);
const setdefault = (o, k, v) => { if (!has(o, k)) Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true }); return o[k]; };

/** "region:sub/loc" split like Python's split(":", 1) / split("/", 1); null when a separator is missing. */
function splitAddress(address) {
    const c = address.indexOf(':');
    if (c < 0) return null;
    const rest = address.slice(c + 1), s = rest.indexOf('/');
    if (s < 0) return null;
    return [address.slice(0, c), rest.slice(0, s), rest.slice(s + 1)];
}

function room(raw, address, where) {
    const parts = typeof address === 'string' ? splitAddress(address) : null;
    const [rid, sid, lid] = parts ?? [];
    const r = parts && get(get(get(get(raw, rid), 'subregions'), sid), 'locations');
    if (!parts || !isObj(get(raw, rid)) || !isObj(r) || !has(r, lid)) throw new WorldError(`${where}: room ${repr(address)} does not exist`);
    return r[lid];
}

function text(ch, key, where) {
    const v = get(ch, key);
    if (typeof v !== 'string' || !strip(v)) throw new WorldError(`${where}: "${key}" must be a non-empty string`);
    return strip(v);
}

const sameDir = (e, d) => String(isObj(e) && has(e, 'direction') ? e.direction : '').toLowerCase() === d.toLowerCase();
const exitsOf = r => (isObj(r) && has(r, 'exits') ? r.exits : []);

/** Copies of world.json and the region files with `changes` applied in order. Throws WorldError if invalid. */
export function apply_changes(worldJson, rawIn, changes) {
    worldJson = structuredClone(worldJson);
    const raw = structuredClone(rawIn);
    if (!Array.isArray(changes)) throw new WorldError('changes must be a list');
    changes.forEach((ch, i) => {
        const where = `change #${i + 1}`;
        if (!isObj(ch) || !CHANGE_TYPES.includes(get(ch, 'type'))) {
            throw new WorldError(`${where}: unknown change type ${repr(isObj(ch) ? get(ch, 'type') : ch)} (known: ${CHANGE_TYPES.join(', ')})`);
        }
        if (ch.type === 'add_room') {
            const address = text(ch, 'address', where);
            const parts = splitAddress(address);
            const sub = parts && get(get(get(raw, parts[0]), 'subregions'), parts[1]);
            if (!parts || !isObj(get(raw, parts[0])) || !isObj(get(raw, parts[0]).subregions) || !has(raw[parts[0]].subregions, parts[1])) {
                throw new WorldError(`${where}: no subregion for new room ${repr(address)}`);
            }
            const lid = parts[2];
            if (!/^[a-z0-9]+(_[a-z0-9]+)*$/.test(lid || '')) throw new WorldError(`${where}: bad room id ${repr(lid)}`);
            const locs = setdefault(sub, 'locations', {});
            if (has(locs, lid)) throw new WorldError(`${where}: room ${repr(address)} already exists`);
            const name = text(ch, 'name', where), desc = text(ch, 'description', where);
            if (plen(name) > MAX_NAME || plen(desc) > MAX_DESCRIPTION) throw new WorldError(`${where}: name or description too long`);
            locs[lid] = { name, description: desc, exits: [] };
            return;
        }
        if (ch.type === 'dig') {
            const a = text(ch, 'from', where), b = text(ch, 'to', where);
            if (a === b) throw new WorldError(`${where}: a passage must lead somewhere else`);
            const pairs = [[a, text(ch, 'direction', where), b, get(ch, 'description')],
                [b, text(ch, 'return_direction', where), a, get(ch, 'return_description')]];
            for (const [frm, d, to] of pairs) {
                if (plen(d) > MAX_DIRECTION) throw new WorldError(`${where}: exit name ${repr(d)} too long`);
                const r = room(raw, frm, where);
                room(raw, to, where);
                if (exitsOf(r).some(e => sameDir(e, d))) throw new WorldError(`${where}: ${frm} already has an exit ${repr(d)}`);
            }
            for (const [frm, d, to, desc] of pairs) {
                setdefault(room(raw, frm, where), 'exits', []).push({ direction: d, to, ...(typeof desc === 'string' && strip(desc) ? { description: strip(desc) } : {}) });
            }
            return;
        }
        if (ch.type === 'view_link') {
            const r = room(raw, text(ch, 'from', where), where), to = text(ch, 'to', where);
            room(raw, to, where);
            if (to === ch.from) throw new WorldError(`${where}: a room can't look out on itself`);
            const views = setdefault(r, 'views', []);
            if (!views.includes(to)) views.push(to);
            return;
        }
        const r = room(raw, text(ch, 'from', where), where);
        if (ch.type === 'open_door' || ch.type === 'close_door') {
            const d = text(ch, 'direction', where);
            if (!exitsOf(r).some(e => sameDir(e, d))) throw new WorldError(`${where}: ${ch.from} has no exit ${repr(d)}`);
            return;
        }
        const direction = text(ch, 'direction', where);
        const exits = setdefault(r, 'exits', []);
        const same = exits.filter(e => sameDir(e, direction));
        if (ch.type === 'add_exit') {
            const to = text(ch, 'to', where);
            room(raw, to, where);
            if (same.length) throw new WorldError(`${where}: ${ch.from} already has an exit ${repr(direction)}`);
            const d = get(ch, 'description');
            exits.push({ direction, to, ...(typeof d === 'string' && strip(d) ? { description: strip(d) } : {}) });
        } else {
            if (!same.length) throw new WorldError(`${where}: ${ch.from} has no exit ${repr(direction)}`);
            r.exits = exits.filter(e => !same.includes(e));
        }
    });
    return [worldJson, raw];
}
