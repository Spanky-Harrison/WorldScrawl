// Loads and validates the static world map (worlds/<id>/world.json + worlds/<id>/regions/*.json).
//
// Region file layout:
//   {name, notes?, start: "sub/loc",
//    subregions: {sub_id: {name, notes?, inherit_notes?: bool (default true),
//                          locations: {loc_id: {name, description, inherit_region_notes?: bool,
//                                               inherit_subregion_notes?: bool, exits: [...]}}}}}
// Full address: "region:sub/loc". Exit "to": "loc" (same subregion), "sub/loc" (same region) or "region:sub/loc".
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const SLUG = /^[a-z0-9]+(?:_[a-z0-9]+)*$/;
export const VIEWS = ['open', 'closed', 'none']; // optional exit "view" (default: closed if hidden/obscured, else open)
export const EXIT_FLAGS = ['hidden', 'obscured'];

/** Where log lines go (the plugin points this at SillyTavern's console; tests capture it). */
export const log = {
    info: (...a) => console.log('[WorldScrawl]', ...a),
    warning: (...a) => console.warn('[WorldScrawl]', ...a),
};

export class WorldError extends Error {
    constructor(message) { super(message); this.name = 'WorldError'; }
}

export const has = (o, k) => o !== null && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k);
export const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
export const sha1 = s => crypto.createHash('sha1').update(s, 'utf8').digest('hex');
/** Python's len() and [:n]: count code points, not UTF-16 units. */
export const plen = s => [...s].length;
export const pslice = (s, n) => [...s].slice(0, n).join('');
const PY_WS = /^[\s\x1c-\x1f\x85]+|[\s\x1c-\x1f\x85]+$/g;
/** Python's str.strip(). */
export const strip = s => s.replace(PY_WS, '');

/** Python repr(), for error and log messages that quote values the same way the Python server did. */
export function repr(v) {
    if (v === null || v === undefined) return 'None';
    if (v === true) return 'True';
    if (v === false) return 'False';
    if (typeof v === 'number') return Number.isInteger(v) && !Object.is(v, -0) ? String(v) : String(v);
    if (typeof v === 'string') {
        const q = v.includes("'") && !v.includes('"') ? '"' : "'";
        let out = '';
        for (const ch of v) {
            const c = ch.codePointAt(0);
            if (ch === '\\') out += '\\\\';
            else if (ch === q) out += '\\' + q;
            else if (ch === '\n') out += '\\n';
            else if (ch === '\r') out += '\\r';
            else if (ch === '\t') out += '\\t';
            else if (c < 0x20 || c === 0x7f) out += '\\x' + c.toString(16).padStart(2, '0');
            else out += ch;
        }
        return q + out + q;
    }
    if (Array.isArray(v)) return '[' + v.map(repr).join(', ') + ']';
    return '{' + Object.entries(v).map(([k, x]) => `${repr(k)}: ${repr(x)}`).join(', ') + '}';
}

/** JSON.parse that refuses duplicate keys (like the Python loader's object_pairs_hook) and reports line/column. */
export function parseJsonStrict(text) {
    let i = 0;
    const fail = (msg, at = i) => {
        const before = text.slice(0, at);
        const line = before.split('\n').length;
        const col = at - before.lastIndexOf('\n');
        const e = new SyntaxError(msg); e.lineno = line; e.colno = col; throw e;
    };
    const ws = () => { while (i < text.length && ' \t\n\r'.includes(text[i])) i++; };
    const str = () => {
        const s = i; i++;
        for (;;) {
            if (i >= text.length) fail('Unterminated string starting at', s);
            const c = text[i];
            if (c === '"') { i++; break; }
            if (c === '\\') { i += 2; continue; }
            if (c.charCodeAt(0) < 0x20) fail('Invalid control character at');
            i++;
        }
        try { return JSON.parse(text.slice(s, i)); } catch { fail('Invalid \\escape', s); }
    };
    const value = () => {
        ws();
        const c = text[i];
        if (c === '{') {
            i++; const obj = {}; ws();
            if (text[i] === '}') { i++; return obj; }
            for (;;) {
                ws();
                if (text[i] !== '"') fail('Expecting property name enclosed in double quotes');
                const k = str(); ws();
                if (text[i] !== ':') fail("Expecting ':' delimiter");
                i++;
                const v = value();
                if (has(obj, k)) throw new WorldError(`duplicate key ${repr(k)}`);
                Object.defineProperty(obj, k, { value: v, enumerable: true, writable: true, configurable: true });
                ws();
                if (text[i] === ',') { i++; continue; }
                if (text[i] === '}') { i++; return obj; }
                fail("Expecting ',' delimiter");
            }
        }
        if (c === '[') {
            i++; const arr = []; ws();
            if (text[i] === ']') { i++; return arr; }
            for (;;) {
                arr.push(value()); ws();
                if (text[i] === ',') { i++; continue; }
                if (text[i] === ']') { i++; return arr; }
                fail("Expecting ',' delimiter");
            }
        }
        if (c === '"') return str();
        for (const [lit, v] of [['true', true], ['false', false], ['null', null]]) {
            if (text.startsWith(lit, i)) { i += lit.length; return v; }
        }
        const m = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(i, i + 400));
        if (m) { i += m[0].length; return Number(m[0]); }
        fail('Expecting value');
    };
    const v = value(); ws();
    if (i < text.length) fail('Extra data');
    return v;
}

export function loadJson(file) {
    const name = path.basename(file);
    let text = fs.readFileSync(file, 'utf8');
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    try {
        return parseJsonStrict(text);
    } catch (e) {
        if (e instanceof WorldError) throw new WorldError(`${name}: ${e.message}`);
        if (e instanceof SyntaxError) throw new WorldError(`${name}: invalid JSON at line ${e.lineno}, column ${e.colno}: ${e.message}`);
        throw e;
    }
}

export class Exit {
    constructor(direction, to, description = null, flags = {}, view = null, stays_open = null) {
        this.direction = direction; this.to = to; this.description = description; this.flags = flags;
        this.door = null; // opaque id shared by a flagged/closed exit and its return exit (derived at load)
        this.view = view; this.stays_open = stays_open;
    }
    get flagged() { return Boolean(this.flags.hidden || this.flags.obscured); }
    get effective_view() { return this.view || (this.flagged ? 'closed' : 'open'); }
}

export function room_token(address) {
    return 'room_' + sha1(`room|${address}`).slice(0, 12);
}

export class World {
    constructor(start, regions, subregions, locations) {
        this.start = start; this.regions = regions; this.subregions = subregions; this.locations = locations; // Maps
        this.doors = new Map(); // door id -> {rooms: [a, b], stays_open}
    }
    get(address) { return this.locations.get(address) ?? null; }
    sub_of(loc) { return this.subregions.get(`${loc.region}:${loc.subregion}`); }
    effective_notes(loc) {
        const region = this.regions.get(loc.region), sub = this.sub_of(loc);
        const useRegion = loc.inherit_region_notes === null ? sub.inherit_notes : loc.inherit_region_notes;
        const useSub = loc.inherit_subregion_notes === null ? true : loc.inherit_subregion_notes;
        return { region: useRegion ? region.notes : null, subregion: useSub ? sub.notes : null };
    }
    static place_label(name, subName) { return subName && subName !== name ? `${name} (${subName})` : name; }
    inherited_stays_open(loc) {
        for (const v of [this.sub_of(loc).stays_open, this.regions.get(loc.region).stays_open]) if (v !== null) return v;
        return false;
    }
    stays_open(e, src) {
        if (e.door && this.doors.has(e.door)) return this.doors.get(e.door).stays_open;
        return e.stays_open !== null ? e.stays_open : this.inherited_stays_open(src);
    }
    static summary(loc) { return pslice(strip(loc.description).split(/(?<=[.!?])\s/u)[0], 160); }
    view_dict(address) {
        const t = this.locations.get(address);
        return { address, name: t.name, display_name: World.place_label(t.name, this.sub_of(t).name), summary: World.summary(t) };
    }
    to_dict(loc) {
        const region = this.regions.get(loc.region), sub = this.sub_of(loc);
        return {
            address: loc.address,
            room_token: room_token(loc.address),
            region: { id: region.id, name: region.name, notes: region.notes, entrance: region.entrance },
            subregion: { id: sub.id, name: sub.name, notes: sub.notes, entrance: sub.entrance,
                entrance_name: this.locations.get(sub.entrance).name, label_rooms: sub.label_rooms },
            name: loc.name,
            display_name: World.place_label(loc.name, sub.name),
            description: loc.description,
            effective_notes: this.effective_notes(loc),
            exits: loc.exits.map(e => this._exit_dict(e, loc)),
            views: loc.views.map(a => this.view_dict(a)),
        };
    }
    static reveals_destination(e) { return !(e.flags.hidden || e.flags.obscured); }
    door_reveals(doors) {
        const want = new Set(doors), out = [];
        for (const loc of this.locations.values()) {
            for (const e of loc.exits) {
                if (e.flagged && want.has(e.door)) out.push({ from: loc.address, ...this.destination_dict(e, loc, { direction: e.direction, ...e.flags, door: e.door }) });
            }
        }
        return out;
    }
    exit_label(src, target) {
        const tsub = this.sub_of(target);
        if (target.region === src.region && target.subregion === src.subregion) return target.name;
        let label;
        if (tsub.label_rooms || target.name === tsub.name) label = target.name;
        else if (tsub.entrance === target.address) label = tsub.name;
        else label = `${tsub.name}, ${target.name}`;
        if (target.region !== src.region) label += `, ${this.regions.get(target.region).name}`;
        return label;
    }
    _exit_dict(e, src = null) {
        const out = {
            direction: e.direction, ...(e.description ? { description: e.description } : {}), ...e.flags,
            ...(e.door && this.doors.has(e.door) ? { door: e.door, door_rooms: this.doors.get(e.door).rooms.map(room_token) } : {}),
            view: e.effective_view,
            ...(src !== null ? { stays_open: this.stays_open(e, src) } : {}),
        };
        if (!World.reveals_destination(e)) return out;
        return this.destination_dict(e, src, out);
    }
    destination_dict(e, src, out) {
        const target = this.locations.get(e.to);
        const tsub = this.sub_of(target), treg = this.regions.get(target.region);
        return {
            direction: e.direction,
            to: e.to,
            to_name: target.name,
            to_display_name: World.place_label(target.name, tsub.name),
            to_summary: World.summary(target),
            to_label: src !== null ? this.exit_label(src, target) : target.name,
            to_subregion: { id: tsub.id, name: tsub.name, entrance: tsub.entrance, label_rooms: tsub.label_rooms },
            to_region: { id: treg.id, name: treg.name, entrance: treg.entrance },
            ...out,
        };
    }
}

function requireStr(obj, key, where, optional = false) {
    if (!has(obj, key)) {
        if (optional) return null;
        throw new WorldError(`${where}: missing "${key}"`);
    }
    const v = obj[key];
    if (typeof v !== 'string' || !strip(v)) throw new WorldError(`${where}: "${key}" must be a non-empty string`);
    return v;
}

function optionalBool(obj, key, where) {
    if (!has(obj, key)) return null;
    if (typeof obj[key] !== 'boolean') throw new WorldError(`${where}: "${key}" must be true or false`);
    return obj[key];
}

function checkSlug(value, where) {
    if (!SLUG.test(value)) throw new WorldError(`${where}: ${repr(value)} is not a valid id (use lowercase letters, digits and single underscores, e.g. "old_mill")`);
}

const count = (s, ch) => s.split(ch).length - 1;

export function resolve_address(ref, region, sub) {
    if (ref.includes(':')) return ref;
    if (ref.includes('/')) return `${region}:${ref}`;
    return `${region}:${sub}/${ref}`;
}

const isFile = p => { try { return fs.statSync(p).isFile(); } catch { return false; } };
const isDir = p => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
export { isFile, isDir };

/** Region files of a world folder, sorted like Python's sorted(glob("*.json")). */
export function regionFiles(root) {
    const dir = path.join(root, 'regions');
    if (!isDir(dir)) return [];
    return fs.readdirSync(dir).filter(n => n.endsWith('.json') && isFile(path.join(dir, n))).sort().map(n => path.join(dir, n));
}

/** The hand-written files as plain JSON: [world.json, {region_id: region file}]. */
export function read_world_raw(root) {
    const worldFile = path.join(root, 'world.json');
    if (!isFile(worldFile)) throw new WorldError(`${worldFile} not found`);
    const worldJson = loadJson(worldFile);
    if (!isObj(worldJson)) throw new WorldError('world.json: must be a JSON object');
    const files = regionFiles(root);
    if (!files.length) throw new WorldError(`no region files found in ${path.join(root, 'regions')}`);
    const raw = {};
    for (const p of files) Object.defineProperty(raw, path.basename(p, '.json'), { value: loadJson(p), enumerable: true, writable: true, configurable: true });
    return [worldJson, raw];
}

export const load_world = root => build_world(...read_world_raw(root));

/** Validate and build a World from plain JSON (as read from a world folder, possibly with changes applied). */
export function build_world(worldJson, rawRegions) {
    const startRegion = requireStr(worldJson, 'start_region', 'world.json');
    if (has(worldJson, 'living') && typeof worldJson.living !== 'boolean') throw new WorldError('world.json: "living" must be true or false');
    const files = Object.keys(rawRegions).sort();
    const regions = new Map(), subregions = new Map(), regionStarts = new Map(), locations = new Map();
    const rawExits = [], rawViews = [];

    for (const rid of files) {
        const fname = `${rid}.json`;
        const data = rawRegions[rid];
        if (!isObj(data)) throw new WorldError(`${fname}: must be a JSON object`);
        checkSlug(rid, `${fname}: region id (file name)`);
        if (has(data, 'id') && data.id !== rid) throw new WorldError(`${fname}: region id ${repr(data.id)} must match the file name (${repr(rid)})`);
        const region = { id: rid, name: requireStr(data, 'name', fname), notes: requireStr(data, 'notes', fname, true), entrance: '',
            stays_open: optionalBool(data, 'stays_open', fname) };
        regions.set(rid, region);
        const start = requireStr(data, 'start', fname);
        if (count(start, '/') !== 1) throw new WorldError(`${fname}: "start" must look like "subregion/location", got ${repr(start)}`);
        regionStarts.set(rid, start);
        const regionEntrance = requireStr(data, 'entrance', fname, true);
        if (regionEntrance !== null && count(regionEntrance, '/') !== 1) throw new WorldError(`${fname}: "entrance" must look like "subregion/location", got ${repr(regionEntrance)}`);
        region.entrance = `${rid}:${regionEntrance || start}`;
        const subs = data.subregions;
        if (!isObj(subs) || !Object.keys(subs).length) throw new WorldError(`${fname}: "subregions" must be a non-empty object keyed by subregion id`);
        for (const [sid, sub] of Object.entries(subs)) {
            const swhere = `${fname}: subregion ${repr(sid)}`;
            checkSlug(sid, `${fname}: subregion id`);
            if (!isObj(sub)) throw new WorldError(`${swhere}: must be an object`);
            const inherit = optionalBool(sub, 'inherit_notes', swhere);
            const locs = sub.locations;
            if (!isObj(locs) || !Object.keys(locs).length) throw new WorldError(`${swhere}: "locations" must be a non-empty object keyed by location id`);
            const entrance = requireStr(sub, 'entrance', swhere, true) || Object.keys(locs)[0];
            if (!has(locs, entrance)) throw new WorldError(`${swhere}: entrance ${repr(entrance)} is not a room in this subregion`);
            subregions.set(`${rid}:${sid}`, {
                id: sid, name: requireStr(sub, 'name', swhere), notes: requireStr(sub, 'notes', swhere, true),
                inherit_notes: inherit === null ? true : inherit, entrance: `${rid}:${sid}/${entrance}`,
                label_rooms: Boolean(optionalBool(sub, 'label_rooms', swhere)), stays_open: optionalBool(sub, 'stays_open', swhere),
            });
            for (const [lid, loc] of Object.entries(locs)) {
                const where = `${fname}: location ${sid}/${lid}`;
                checkSlug(lid, `${fname}: location id`);
                if (!isObj(loc)) throw new WorldError(`${where}: must be an object`);
                const exitsRaw = has(loc, 'exits') ? loc.exits : [];
                if (!Array.isArray(exitsRaw)) throw new WorldError(`${where}: "exits" must be a list`);
                const exits = [], seenDirs = new Set();
                exitsRaw.forEach((ex, i) => {
                    const ewhere = `${where}, exit #${i + 1}`;
                    if (!isObj(ex)) throw new WorldError(`${ewhere}: must be an object`);
                    const direction = strip(requireStr(ex, 'direction', ewhere));
                    if (seenDirs.has(direction.toLowerCase())) throw new WorldError(`${ewhere}: direction ${repr(direction)} is used twice`);
                    seenDirs.add(direction.toLowerCase());
                    const flags = {};
                    for (const flag of EXIT_FLAGS) {
                        const v = optionalBool(ex, flag, ewhere);
                        if (v !== null) flags[flag] = v;
                    }
                    const view = has(ex, 'view') ? ex.view : null;
                    if (view !== null && !VIEWS.includes(view)) throw new WorldError(`${ewhere}: "view" must be one of ${VIEWS.join(', ')}`);
                    const e = new Exit(direction, strip(requireStr(ex, 'to', ewhere)), requireStr(ex, 'description', ewhere, true), flags,
                        view, optionalBool(ex, 'stays_open', ewhere));
                    exits.push(e);
                    rawExits.push([ewhere, rid, sid, e]);
                });
                const views = has(loc, 'views') ? loc.views : [];
                if (!Array.isArray(views) || !views.every(v => typeof v === 'string' && strip(v))) throw new WorldError(`${where}: "views" must be a list of room addresses`);
                const address = `${rid}:${sid}/${lid}`;
                rawViews.push([where, rid, sid, address, views]);
                locations.set(address, {
                    address, region: rid, subregion: sid, id: lid, name: requireStr(loc, 'name', where), description: requireStr(loc, 'description', where), exits,
                    inherit_region_notes: optionalBool(loc, 'inherit_region_notes', where), inherit_subregion_notes: optionalBool(loc, 'inherit_subregion_notes', where),
                    views: [],
                });
            }
        }
    }

    for (const [where, rid, sid, e] of rawExits) {
        const target = resolve_address(e.to, rid, sid);
        if (!locations.has(target)) throw new WorldError(`${where}: exit target ${repr(e.to)} does not exist (looked for ${repr(target)})`);
        e.to = target;
    }
    for (const [where, rid, sid, address, views] of rawViews) {
        for (const v of views) {
            const target = resolve_address(strip(v), rid, sid);
            if (!locations.has(target)) throw new WorldError(`${where}: view ${repr(v)} does not exist (looked for ${repr(target)})`);
            const lv = locations.get(address).views;
            if (!lv.includes(target)) lv.push(target);
        }
    }
    for (const [rid, start] of regionStarts) {
        if (!locations.has(`${rid}:${start}`)) throw new WorldError(`${rid}.json: start location ${repr(start)} does not exist in region ${repr(rid)}`);
        const ent = regions.get(rid).entrance;
        if (!locations.has(ent)) throw new WorldError(`${rid}.json: entrance ${repr(ent.split(':').slice(1).join(':'))} does not exist in region ${repr(rid)}`);
    }
    if (!regions.has(startRegion)) throw new WorldError(`world.json: start_region ${repr(startRegion)} has no matching file in regions/`);

    // Pair every hidden/obscured (or closed) exit with its return exit: passing through either side reveals both.
    for (const loc of locations.values()) {
        for (const e of loc.exits) {
            if (!(e.flagged || e.effective_view === 'closed') || e.door) continue;
            const back = locations.get(e.to).exits.find(b => b.to === loc.address) ?? null;
            const ends = [`${loc.address}|${e.direction.toLowerCase()}`, ...(back ? [`${e.to}|${back.direction.toLowerCase()}`] : [])].sort();
            e.door = 'door_' + sha1(ends.join('&')).slice(0, 10);
            if (back === null) log.warning(`world: ${loc.address} exit ${repr(e.direction)} is hidden/obscured but has no return exit (one-way door)`);
            else if (back.door === null) back.door = e.door;
        }
    }

    const w = new World(`${startRegion}:${regionStarts.get(startRegion)}`, regions, subregions, locations);
    for (const loc of locations.values()) {
        for (const e of loc.exits) {
            if (!e.door || w.doors.has(e.door)) continue;
            const back = locations.get(e.to).exits.find(b => b.to === loc.address && b.door === e.door) ?? null;
            const explicit = [e, back].filter(x => x !== null && x.stays_open !== null).map(x => x.stays_open);
            const stays = explicit.length ? explicit.every(Boolean) : (w.inherited_stays_open(loc) && w.inherited_stays_open(locations.get(e.to)));
            w.doors.set(e.door, { rooms: [...new Set([loc.address, e.to])].sort(), stays_open: stays });
        }
    }
    return w;
}
