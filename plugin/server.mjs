// WorldScrawl API: stateless, read-only maps (one per world folder). Framework-free: handle() takes a method,
// URL and parsed JSON body and returns {status, headers, body}; index.mjs mounts it on SillyTavern's router.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { apply_changes } from './changes.mjs';
import { activeChanges, applyPatch, PatchError, getRoom, normalizeRefs, neighborsOf, mentionsOf } from './ui/patches.mjs';
import { inspect, inspectIndex } from './inspect.mjs';
import { resolvePosition, relocateMap } from './position.mjs';
import { GREGORIAN, advanceStart, checkCalendar, checkStart } from './ui/calendar.mjs';
import { World, WorldError, build_world, has, isDir, isFile, isObj, log, read_world_raw, regionFiles, repr, strip } from './world.mjs';

export const DEFAULT_WORLD_ID = 'riverton';
export const VERSION_HEADER = 'X-WorldScrawl-Map-Version';
const WORLD_ID = /^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/; // world ids = folder names: letters, digits, dashes

export class HttpError extends Error {
    constructor(status, detail) { super(typeof detail === 'string' ? detail : JSON.stringify(detail)); this.status = status; this.detail = detail; }
}

/** Short hash of world.json + every region file. Changes whenever the map files change. */
export function map_version(root) {
    const h = crypto.createHash('sha256');
    for (const p of [path.join(root, 'world.json'), ...regionFiles(root)]) {
        h.update(Buffer.from(path.basename(p), 'utf8'));
        h.update(fs.readFileSync(p));
    }
    return h.digest('hex').slice(0, 12);
}

/** Readable folder id from a name: "Riverton - Desirae - Oct 19" -> "riverton-desirae-oct-19". */
export function slugify(text) {
    const trim = s => s.replace(/^-+|-+$/g, '');
    return trim(trim(String(text).toLowerCase().replace(/[^a-z0-9]+/g, '-')).slice(0, 48)) || 'world';
}

export const valid_world_id = wid => typeof wid === 'string' && wid.length <= 64 && WORLD_ID.test(wid);

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** strftime('%b %d, %I:%M %p').replace(' 0', ' ') in local time, e.g. "Oct 5, 4:07 PM". */
export function autoStamp(d = new Date()) {
    const p2 = n => String(n).padStart(2, '0');
    const h = d.getHours() % 12 || 12;
    return `${MONTHS[d.getMonth()]} ${p2(d.getDate())}, ${p2(h)}:${p2(d.getMinutes())} ${d.getHours() < 12 ? 'AM' : 'PM'}`.replaceAll(' 0', ' ');
}

const writeJson = (file, data) => fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf8');
const stable = v => JSON.stringify(v, (k, x) => (isObj(x) ? Object.fromEntries(Object.keys(x).sort().map(key => [key, x[key]])) : x));

export function clean_knowledge(k, world) {
    if (!isObj(k)) throw new WorldError('knowledge must be an object');
    const list = v => (Array.isArray(v) ? v : typeof v === 'string' ? [...v] : isObj(v) ? Object.keys(v) : []);
    const addrs = key => [...new Set(list(has(k, key) ? k[key] : null))].filter(a => typeof a === 'string' && world.get(a));
    const doors = new Set();
    for (const l of world.locations.values()) for (const e of l.exits) if (e.door) doors.add(e.door);
    const loc = has(k, 'location') ? k.location : null;
    return { location: typeof loc === 'string' && world.get(loc) ? loc : null, stood: addrs('stood'), seen: addrs('seen'),
        doors: [...new Set(list(has(k, 'doors') ? k.doors : null))].filter(d => typeof d === 'string' && doors.has(d)) };
}

class LoadedWorld {
    constructor(wid, root) {
        this.id = wid; this.root = root;
        this.raw = read_world_raw(root);
        this.world = build_world(...this.raw);
        this.version = map_version(root);
        this.name = typeof this.raw[0].name === 'string' && has(this.raw[0], 'name') ? this.raw[0].name : wid;
        this.living = this.raw[0].living === true; // living saves may be saved over; missing/false = protected
        this.knowledge = null;
        const kf = path.join(root, 'knowledge.json');
        if (isFile(kf)) {
            try { this.knowledge = clean_knowledge(JSON.parse(fs.readFileSync(kf, 'utf8')), this.world); } catch (e) { log.warning(`world ${wid}: ignoring knowledge.json (${e.message})`); }
        }
    }
    info() {
        return { id: this.id, name: this.name, start_region: this.world.start.split(':')[0], start: this.world.start,
            map_version: this.version, has_knowledge: this.knowledge !== null, living: this.living, ...this.time() };
    }
    /** The world's calendar (default Gregorian) and start_date (missing fields filled in). */
    time() {
        const calendar = this.raw[0].calendar ?? GREGORIAN;
        const s = checkStart(this.raw[0].start_date, checkCalendar(calendar));
        return { calendar, start_date: advanceStart({ year: s.year, month: calendar.months[s.mi].name, day: s.day, time: '00:00' }, s.secs, calendar), weather: this.world.weather };
    }
}

// ---- request bodies (the same rules as the Python server's pydantic models; failures are 422 like FastAPI)
const TYPES = { 'Field required': 'missing', 'Input should be a valid string': 'string_type', 'Input should be a valid dictionary': 'dict_type',
    'Input should be a valid boolean': 'bool_type', 'Input should be a valid integer': 'int_type', 'Input should be a valid list': 'list_type' };
const bad = (field, msg, input) => { throw new HttpError(422, [{ type: TYPES[msg] ?? 'value_error', loc: ['body', ...(field ? [field] : [])], msg, input }]); };
function field(body, key, kind, dflt) {
    if (!has(body, key)) {
        if (dflt === undefined) bad(key, 'Field required', body);
        return dflt;
    }
    const v = body[key];
    switch (kind) {
        case 'str': if (typeof v !== 'string') bad(key, 'Input should be a valid string', v); return v;
        case 'str?': if (v !== null && typeof v !== 'string') bad(key, 'Input should be a valid string', v); return v;
        case 'list': if (!Array.isArray(v)) bad(key, 'Input should be a valid list', v); return v;
        case 'strs': if (!Array.isArray(v) || !v.every(x => typeof x === 'string')) bad(key, 'Input should be a list of strings', v); return v;
        case 'dict?': if (v !== null && !isObj(v)) bad(key, 'Input should be a valid dictionary', v); return v;
        case 'bool': {
            if (typeof v === 'boolean') return v;
            if (v === 0 || v === 1) return v === 1;
            const s = typeof v === 'string' ? v.toLowerCase() : null;
            if (['true', 't', 'yes', 'y', 'on', '1'].includes(s)) return true;
            if (['false', 'f', 'no', 'n', 'off', '0'].includes(s)) return false;
            return bad(key, 'Input should be a valid boolean', v);
        }
        default: { // int with bounds: [lo, hi]
            const n = typeof v === 'string' && /^\s*-?\d+\s*$/.test(v) ? Number(v) : v;
            if (typeof n !== 'number' || !Number.isInteger(n)) bad(key, 'Input should be a valid integer', v);
            if (n < kind[0]) bad(key, `Input should be greater than or equal to ${kind[0]}`, v);
            if (n > kind[1]) bad(key, `Input should be less than or equal to ${kind[1]}`, v);
            return n;
        }
    }
}
const nowOf = body => (isObj(body) && typeof body.now === 'number' && Number.isFinite(body.now) ? body.now : null);
const needBody = body => { if (!isObj(body)) bad(null, body === undefined ? 'Field required' : 'Input should be a valid dictionary', body ?? null); return body; };

/**
 * Serve every world folder in `worldsDir`. `worldDir` (or WORLDSCRAWL_WORLD_DIR) instead serves that single folder
 * as world "default" (tests, old setups). Throws WorldError when there is nothing to serve or a world is broken.
 */
export function createServer({ worldDir = null, worldsDir = null, env = process.env, defaultWorldsDir = null } = {}) {
    const single = worldDir || env.WORLDSCRAWL_WORLD_DIR;
    const worlds = new Map();
    let rootDir = null, defaultId;
    if (single) {
        worlds.set('default', new LoadedWorld('default', path.resolve(single)));
        defaultId = 'default';
    } else {
        rootDir = path.resolve(worldsDir || env.WORLDSCRAWL_WORLDS_DIR || defaultWorldsDir);
        for (const name of isDir(rootDir) ? fs.readdirSync(rootDir).sort() : []) {
            const d = path.join(rootDir, name);
            if (name.startsWith('.') || !isFile(path.join(d, 'world.json'))) continue; // .backups, temp folders
            if (!valid_world_id(name)) { log.warning(`worlds: skipping folder ${repr(name)} (world ids are letters, digits and dashes)`); continue; }
            worlds.set(name, new LoadedWorld(name, d)); // a broken world fails loudly at startup, like before
        }
        if (!worlds.size) throw new WorldError(`no worlds found in ${rootDir}`);
        const want = env.WORLDSCRAWL_DEFAULT_WORLD || DEFAULT_WORLD_ID;
        defaultId = worlds.has(want) ? want : worlds.keys().next().value;
    }

    function rescan() {
        if (rootDir === null) return;
        const seen = new Set();
        for (const name of isDir(rootDir) ? fs.readdirSync(rootDir).sort() : []) {
            const d = path.join(rootDir, name);
            if (name.startsWith('.') || !isFile(path.join(d, 'world.json')) || !valid_world_id(name)) continue;
            seen.add(name);
            try {
                if (!worlds.has(name) || worlds.get(name).version !== map_version(d)) {
                    worlds.set(name, new LoadedWorld(name, d));
                    log.info(`worlds: loaded ${name}`);
                }
            } catch (e) { log.warning(`worlds: skipping ${name} (${e.message})`); }
        }
        for (const wid of [...worlds.keys()].filter(w => !seen.has(w) && w !== defaultId)) {
            log.info(`worlds: ${wid} is gone`);
            worlds.delete(wid);
        }
    }

    function get_world(wid) {
        if (wid === null || wid === undefined || wid === '') return worlds.get(defaultId);
        if (!valid_world_id(wid)) throw new HttpError(400, `Invalid world id ${repr(wid)} (letters, digits and dashes only).`);
        if (!worlds.has(wid)) rescan();
        if (!worlds.has(wid)) throw new HttpError(404, { error: 'world_not_found', world: wid, message: `World ${repr(wid)} not found (its folder may have been deleted or renamed).` });
        return worlds.get(wid);
    }

    const changedCache = new Map(); // LRU of worlds with a chat's changes applied
    /** The world with a chat's changes applied ({w, worldJson, raw, info}); expired patch ops (game time `now`) left out. */
    function changed_for(wid, changesIn, now = null) {
        const lw = get_world(wid);
        const changes = activeChanges(changesIn, now);
        if (!changes.length) return { w: lw.world, worldJson: lw.raw[0], raw: lw.raw[1], info: { patches: [] } };
        const key = `${lw.id}\u0000${lw.version}\u0000${stable(changes)}`;
        let e = changedCache.get(key);
        if (e === undefined) {
            try {
                const info = { patches: [] };
                const [wj, raw] = apply_changes(...lw.raw, changes, { now, info });
                e = { w: build_world(wj, raw), worldJson: wj, raw, info };
            } catch (err) {
                if (err instanceof WorldError) throw new HttpError(400, { error: err.message });
                throw err;
            }
        }
        changedCache.delete(key);
        changedCache.set(key, e);
        while (changedCache.size > 32) changedCache.delete(changedCache.keys().next().value);
        return e;
    }
    const world_for = (wid, changes, now = null) => changed_for(wid, changes, now).w;

    const step = (world, loc, direction) => {
        const wanted = strip(direction).toLowerCase();
        const e = loc.exits.find(x => x.direction.toLowerCase() === wanted);
        return e && !e.blocked ? world.get(e.to) : null;
    };
    const exitAt = (loc, direction) => loc.exits.find(x => x.direction.toLowerCase() === strip(direction).toLowerCase()) ?? null;
    const blockedError = (loc, e) => `The ${e.direction} exit from ${loc.name} is ${e.barrier.openable ? 'locked' : 'blocked'}.`;
    const stepSeconds = (world, loc, direction) => {
        const wanted = strip(direction).toLowerCase();
        const e = loc.exits.find(x => x.direction.toLowerCase() === wanted);
        return e ? world.travel_seconds(e, loc) : 0;
    };
    const find = (world, address) => {
        const loc = world.get(address);
        if (loc === null) throw new HttpError(404, `Unknown location ${repr(address)}. Addresses look like 'region:subregion/location'.`);
        return loc;
    };

    /** Open a folder in the system file browser (WORLDSCRAWL_NO_OPEN=1 skips it, for tests). */
    function openPath(p) {
        if (env.WORLDSCRAWL_NO_OPEN) return;
        const cmd = process.platform === 'win32' ? 'explorer' : process.platform === 'darwin' ? 'open' : 'xdg-open';
        try {
            const child = spawn(cmd, [p], { detached: true, stdio: 'ignore', windowsHide: false });
            child.on('error', e => log.warning(`open-folder: could not start ${cmd} (${e.message})`));
            child.unref();
        } catch (e) { log.warning(`open-folder: could not start ${cmd} (${e.message})`); }
    }
    const state = { worlds, defaultId, openPath, rootDir };

    const routes = {
        'GET /health': ({ q }) => {
            const lw = get_world(q('world')), w = lw.world;
            return { ok: true, world: lw.id, map_version: lw.version, regions: w.regions.size, locations: w.locations.size, subregions: w.subregions.size, start: w.start };
        },
        'POST /open-folder': ({ q }) => {
            if (rootDir === null) throw new HttpError(400, 'No worlds folder (single WORLDSCRAWL_WORLD_DIR mode).');
            const base = fs.realpathSync(rootDir), world = q('world');
            const p = world === null || world === '' ? base : fs.realpathSync(get_world(world).root);
            const rel = path.relative(base, p);
            if (p !== base && (!rel || rel.startsWith('..') || path.isAbsolute(rel))) throw new HttpError(400, 'Refusing to open a folder outside worlds/.');
            state.openPath(p);
            return { opened: p };
        },
        'GET /worlds': () => {
            rescan(); // folders added/removed by hand show up without a restart
            return { default: defaultId, worlds: [...worlds.values()].map(lw => lw.info()) };
        },
        'GET /start': ({ q }) => { const w = get_world(q('world')).world; return w.to_dict(w.get(w.start)); },
        'GET /rooms': ({ q }) => {
            const w = get_world(q('world')).world;
            const wanted = [...new Set((q('addresses') ?? '').split(',').map(strip).filter(Boolean))];
            const found = wanted.map(a => [a, w.get(a)]);
            return { start: w.to_dict(w.get(w.start)), rooms: found.filter(([, l]) => l !== null).map(([, l]) => w.to_dict(l)), unknown: found.filter(([, l]) => l === null).map(([a]) => a) };
        },
        'POST /rooms': ({ q, body }) => { // the same, with this chat's changes (map patches) applied
            needBody(body);
            const w = world_for(q('world'), field(body, 'changes', 'list', []), nowOf(body));
            const wanted = [...new Set(field(body, 'addresses', 'strs', []).map(strip).filter(Boolean))];
            const found = wanted.map(a => [a, w.get(a)]);
            return { start: w.to_dict(w.get(w.start)), rooms: found.filter(([, l]) => l !== null).map(([, l]) => w.to_dict(l)), unknown: found.filter(([, l]) => l === null).map(([a]) => a) };
        },
        // Map patches. context: what the model needs to write one; preview: check one (never stamped by the server).
        'POST /patch/context': ({ q, body }) => {
            needBody(body);
            const e = changed_for(q('world'), field(body, 'changes', 'list', []), nowOf(body));
            const at = field(body, 'location', 'str'), wanted = field(body, 'rooms', 'strs', []);
            const loc = find(e.w, at), sub = e.w.sub_of(loc);
            const inSub = [...e.w.locations.values()].filter(l => e.w.sub_of(l) === sub);
            const near = new Set(inSub.map(l => l.address));
            for (const l of inSub) for (const x of l.exits) near.add(x.to);
            const outline = [...near].map(a => e.w.get(a)).filter(Boolean).map(l => ({ address: l.address, name: l.name, area: `${l.address.split('/')[0]}`, area_name: e.w.sub_of(l).name,
                exits: l.exits.map(x => ({ direction: x.direction, to: x.to, ...(x.barrier ? { door: x.blocked ? 'blocked' : x.barrier.locked ? 'locked' : 'door' } : {}) })) }));
            const raw = structuredClone(e.raw); normalizeRefs(raw);
            const rooms = {};
            for (const a of wanted) { const r = getRoom(raw, a); if (r) rooms[a] = r; }
            // One step beyond the change: neighbors of every changed room, and of every room in a changed area.
            const affected = [...e.w.locations.keys()].filter(a => wanted.includes(a) || wanted.some(x => !x.includes('/') && (a.startsWith(`${x}/`) || (!x.includes(':') && a.startsWith(`${x}:`)))));
            const neighbors = neighborsOf(e.w, affected);
            // Old-name search: the changed places' names anywhere else in the world's text (rooms, areas, NPCs...).
            const areaName = x => { const [r0, s0] = x.split(':'); return (s0 ? e.raw[r0]?.subregions?.[s0] : e.raw[r0])?.name; };
            const names = [...affected.filter(a => wanted.includes(a)).map(a => e.w.get(a)?.name), ...wanted.filter(x => !x.includes('/')).map(areaName)].filter(Boolean);
            const mentions = mentionsOf(e.raw, names, new Set([...affected, ...wanted]));
            return { location: loc.address, area: loc.address.split('/')[0], area_name: sub.name, region_name: e.w.regions.get(loc.address.split(':')[0])?.name ?? '', outline, rooms, neighbors, mentions,
                areas: Object.fromEntries(wanted.filter(a => !a.includes('/')).map(a => { const [r, s2] = a.split(':'); const o = s2 ? raw[r]?.subregions?.[s2] : raw[r]; return [a, o ? { name: o.name, notes: o.notes ?? '' } : null]; })) };
        },
        'POST /patch/preview': ({ q, body }) => {
            needBody(body);
            const e = changed_for(q('world'), field(body, 'changes', 'list', []), nowOf(body));
            const patch = field(body, 'patch', 'dict?');
            if (!patch) bad('patch', 'Input should be a valid dictionary', patch);
            const raw = structuredClone(e.raw);
            let r;
            try { r = applyPatch(raw, { ...patch, at: nowOf(body) ?? 0 }, { now: null, where: 'patch', dropNoops: true }); build_world(e.worldJson, raw); } catch (err) {
                if (err instanceof PatchError || err instanceof WorldError) throw new HttpError(400, { error: err.message, ...(err.choices ? { choices: err.choices, key: err.key } : {}) });
                throw err;
            }
            const before = structuredClone(e.raw); normalizeRefs(before);
            const touched = [...new Set(r.touched)];
            const areaOf = (src, a) => { const [rid, sid] = a.split(':'); const o = sid ? src[rid]?.subregions?.[sid] : src[rid]; return o ? { name: o.name ?? a, notes: o.notes ?? '', area: true } : null; };
            const pick = src => Object.fromEntries(touched.map(a => [a, a.includes('/') ? getRoom(src, a) : areaOf(src, a)]));
            return { ok: true, ops: r.ops, noops: r.noops, summary: r.summary, relocate: r.relocate, touched: [...new Set(r.touched)], before: pick(before), after: pick(raw) };
        },
        'POST /resolve': ({ q, body }) => {
            // Blanket position resolver: any stored location -> a real room of the effective map.
            needBody(body);
            const wid = q('world'), changes = field(body, 'changes', 'list', []), now = nowOf(body);
            const address = field(body, 'address', 'str');
            const since = typeof body.since === 'number' ? body.since : null;
            const e = changed_for(wid, changes, now);
            const all = changed_for(wid, changes, null);
            const before = a => {
                for (let k = changes.length - 1; k >= 0; k--) { let pw; try { pw = changed_for(wid, changes.slice(0, k), null).w; } catch { continue; } if (pw.locations.has(a)) return pw; }
                return null;
            };
            const r = resolvePosition(e.w, address, { relocate: relocateMap(e.info.patches, since), allRelocate: relocateMap(all.info.patches), before });
            const loc = e.w.locations.get(r.address);
            return { ...r, name: loc?.name ?? r.address, display_name: loc ? World.place_label(loc.name, e.w.sub_of(loc).name) : r.address };
        },
        'POST /move': ({ q, body }) => {
            needBody(body);
            const from = field(body, 'from', 'str'), direction = field(body, 'direction', 'str'), changes = field(body, 'changes', 'list', []);
            const w = world_for(q('world'), changes, nowOf(body));
            const loc = find(w, from), to = step(w, loc, direction);
            if (to !== null) { log.info(`move ${loc.address} -${strip(direction)}-> ${to.address}`); const tr = exitAt(loc, direction)?.traversal; return { ...w.to_dict(to), travel_seconds: stepSeconds(w, loc, direction), ...(tr ? { traversal: tr } : {}) }; }
            const be = exitAt(loc, direction);
            if (be?.blocked) { log.info(`move ${loc.address} -${strip(direction)}-> refused (blocked)`); throw new HttpError(400, { error: blockedError(loc, be), blocked: true, valid_directions: loc.exits.filter(x => !x.blocked).map(x => x.direction) }); }
            log.info(`move ${loc.address} -${strip(direction)}-> refused (no such exit)`);
            throw new HttpError(400, { error: `There is no exit ${repr(direction)} from ${loc.name}.`, valid_directions: loc.exits.map(e => e.direction) });
        },
        'POST /nearby': ({ q, body }) => {
            needBody(body);
            const from = field(body, 'from', 'str'), depth = field(body, 'depth', [1, 6], 3), limit = field(body, 'limit', [1, 30], 12), changes = field(body, 'changes', 'list', []);
            const w = world_for(q('world'), changes, nowOf(body));
            const start = find(w, from);
            const dist = new Map([[start.address, 0]]);
            let frontier = [start];
            for (let d = 1; d <= depth; d++) {
                const nxt = [];
                for (const loc of frontier) for (const e of loc.exits) if (!dist.has(e.to) && w.get(e.to) !== null) { dist.set(e.to, d); nxt.push(w.get(e.to)); }
                frontier = nxt;
            }
            const out = [];
            for (const [a, d] of [...dist].sort((x, y) => x[1] - y[1])) {
                if (d === 0) continue;
                const loc = w.get(a), sub = w.sub_of(loc);
                out.push({ address: a, name: loc.name, area: sub.name, display_name: World.place_label(loc.name, sub.name), summary: World.summary(loc), steps: d });
            }
            return { rooms: out.slice(0, limit) };
        },
        // Read-only inspector (Editor mode in the map window): never writes.
        'GET /inspect/index': ({ q }) => { const lw = get_world(q('world')); return { world: lw.id, map_version: lw.version, ...inspectIndex(lw.world) }; },
        'GET /inspect': ({ q }) => {
            const lw = get_world(q('world')), r = inspect(lw.world, lw.raw, q('target') ?? 'world');
            if (!r) throw new HttpError(404, `Nothing to inspect at ${repr(q('target'))}.`);
            return r;
        },
        'POST /inspect/index': ({ q, body }) => { needBody(body); const lw = get_world(q('world')), e = changed_for(q('world'), field(body, 'changes', 'list', []), nowOf(body)); return { world: lw.id, map_version: lw.version, ...inspectIndex(e.w) }; },
        'POST /inspect': ({ q, body }) => { // with this chat's changes: patched rooms show which message changed them
            needBody(body);
            const e = changed_for(q('world'), field(body, 'changes', 'list', []), nowOf(body));
            const target = field(body, 'target', 'str', 'world');
            const lw = get_world(q('world'));
            const r = inspect(e.w, [e.worldJson, e.raw], target, e.info.patches, { w: lw.world, raw: lw.raw });
            if (!r) throw new HttpError(404, `Nothing to inspect at ${repr(target)}.`);
            return r;
        },
        'POST /doors': ({ q, body }) => { needBody(body); const doors = field(body, 'doors', 'strs'); return { exits: get_world(q('world')).world.door_reveals(doors) }; },
        'POST /travel': ({ q, body }) => {
            needBody(body);
            const from = field(body, 'from', 'str'), steps = field(body, 'steps', 'strs'), changes = field(body, 'changes', 'list', []);
            const w = world_for(q('world'), changes, nowOf(body));
            let at = find(w, from), stopped = false, reason = null, error = null;
            const pathOut = [], stepTimes = [], traversal = [];
            for (const direction of steps) {
                const nxt = step(w, at, direction);
                if (nxt === null) { stopped = true; reason = 'blocked'; const be = exitAt(at, direction); error = be?.blocked ? blockedError(at, be) : `There is no exit ${repr(direction)} from ${at.name}.`; break; }
                stepTimes.push(stepSeconds(w, at, direction));
                traversal.push(exitAt(at, direction)?.traversal ?? null);
                at = nxt;
                pathOut.push(w.to_dict(at));
            }
            log.info(`travel ${from} steps=${repr(steps)} -> ${at.address} (${pathOut.length}/${steps.length} steps${stopped ? `, stopped: ${reason}` : ''})`);
            return { location: w.to_dict(at), path: pathOut, steps_completed: pathOut.length, steps_requested: steps.length, step_seconds: stepTimes, travel_seconds: stepTimes.reduce((a, b) => a + b, 0), step_traversal: traversal, stopped, reason, ...(error ? { error } : {}) };
        },
        'POST /worlds/render': ({ body }) => render(needBody(body)),
    };

    function render(body) {
        const req = {
            base: field(body, 'base', 'str?', null), id: field(body, 'id', 'str?', null), id_hint: field(body, 'id_hint', 'str?', null),
            name: field(body, 'name', 'str?', null), auto: field(body, 'auto', 'bool', false), overwrite: field(body, 'overwrite', 'bool', false),
            changes: field(body, 'changes', 'list', []), knowledge: field(body, 'knowledge', 'dict?', null),
            elapsed: field(body, 'elapsed', [0, Number.MAX_SAFE_INTEGER], 0), // game seconds since the base world's start_date
        };
        if (rootDir === null) throw new HttpError(400, 'Saving worlds needs a worlds folder (not a single WORLDSCRAWL_WORLD_DIR).');
        const base = get_world(req.base);
        const names = new Set([...worlds.values()].map(lw => strip(lw.name).toLowerCase()));
        let name = strip(req.name || '');
        let over = null, wid;
        if (!name || req.auto) {
            const auto = name || `${base.name} - ${autoStamp()}`;
            name = auto;
            for (let n = 1; names.has(name.toLowerCase());) { n += 1; name = `${auto} (${n})`; }
        } else if (names.has(name.toLowerCase())) {
            over = [...worlds.values()].find(lw => strip(lw.name).toLowerCase() === name.toLowerCase());
            if (!over.living) throw new HttpError(409, `A world named ${repr(name)} already exists and is protected (not a living save). Pick another name.`);
        }
        const taken = new Set([...worlds.keys(), ...fs.readdirSync(rootDir)].map(w => w.toLowerCase()));
        if (over !== null && over.id !== base.id && !req.overwrite) {
            throw new HttpError(409, { error: 'needs_overwrite', world: over.id, name: over.name, message: `A world named ${repr(over.name)} already exists. Add overwrite=true to save over it.` });
        }
        if (over !== null) {
            wid = over.id; name = over.name;
        } else if (req.id !== null) {
            if (!valid_world_id(req.id)) throw new HttpError(400, `Invalid world id ${repr(req.id)} (letters, digits and dashes only).`);
            const existing = [...worlds.values()].find(lw => lw.id.toLowerCase() === req.id.toLowerCase()) ?? null;
            if (existing !== null && existing.living) {
                if (existing.id !== base.id && !req.overwrite) {
                    throw new HttpError(409, { error: 'needs_overwrite', world: existing.id, name: existing.name, message: `World ${repr(existing.id)} already exists. Add overwrite=true to save over it.` });
                }
                over = existing; wid = existing.id; name = existing.name;
            } else if (taken.has(req.id.toLowerCase())) {
                throw new HttpError(409, `World ${repr(req.id)} already exists and is protected (not a living save). Pick another name.`);
            } else {
                wid = req.id;
            }
        } else {
            const stem = slugify(req.id_hint || name);
            wid = stem;
            for (let n = 1; taken.has(wid.toLowerCase());) { n += 1; wid = `${stem}-${n}`; }
        }
        const target = path.join(rootDir, wid);
        let wj, raw, know;
        try {
            [wj, raw] = apply_changes(...base.raw, activeChanges(req.changes, typeof req.now === 'number' ? req.now : (typeof req.elapsed === 'number' ? req.elapsed : null)));
            wj.name = name;
            wj.living = true; // saves are living: they can be saved over later
            // Bake the clock in the same write as the changes: the saved world starts when this chat's clock is now.
            const { calendar, start_date } = base.time();
            wj.start_date = advanceStart(start_date, req.elapsed, calendar);
            wj.weather_seed = base.world.weather.seed; // a renamed save keeps the same skies
            const newWorld = build_world(wj, raw); // validate before writing anything
            know = req.knowledge !== null ? clean_knowledge(req.knowledge, newWorld) : null;
        } catch (e) {
            if (e instanceof WorldError) throw new HttpError(400, { error: e.message });
            throw e;
        }
        const tmp = fs.mkdtempSync(path.join(rootDir, `.${wid}-`));
        try {
            fs.mkdirSync(path.join(tmp, 'regions'));
            writeJson(path.join(tmp, 'world.json'), wj);
            for (const [rid, data] of Object.entries(raw)) writeJson(path.join(tmp, 'regions', `${rid}.json`), data);
            if (know !== null) writeJson(path.join(tmp, 'knowledge.json'), know);
            if (over === null) {
                if (fs.existsSync(target)) throw new HttpError(409, `World ${repr(wid)} already exists.`);
                fs.renameSync(tmp, target);
            } else { // swap: the previous version becomes the one backup in .backups/<id>
                const backups = path.join(rootDir, '.backups');
                fs.mkdirSync(backups, { recursive: true });
                const old = path.join(backups, wid);
                if (fs.existsSync(old)) fs.rmSync(old, { recursive: true, force: true });
                fs.renameSync(target, old);
                try { fs.renameSync(tmp, target); } catch (e) { fs.renameSync(old, target); throw e; } // put the previous version back
            }
        } finally {
            if (fs.existsSync(tmp)) fs.rmSync(tmp, { recursive: true, force: true });
        }
        worlds.set(wid, new LoadedWorld(wid, target));
        for (const k of [...changedCache.keys()]) if (k.split('\u0000')[0] === wid) changedCache.delete(k);
        log.info(`render world ${base.id} -> ${wid} (${req.changes.length} changes${over ? ', saved over the previous version' : ''})`);
        return { ...worlds.get(wid).info(), overwritten: over !== null };
    }

    /** One request. url: path + query relative to the mount point. body: parsed JSON, or undefined when none was sent. */
    function handle(method, url, body) {
        const u = new URL(url, 'http://x');
        const q = k => { const all = u.searchParams.getAll(k); return all.length ? all[all.length - 1] : null; };
        let status = 200, out;
        try {
            let p;
            try { p = decodeURIComponent(u.pathname); } catch { throw new HttpError(400, 'Bad request path.'); }
            p = p.replace(/\/+$/, '') || '/';
            let route = routes[`${method} ${p}`], params = {};
            const m = /^\/location\/(.+)$/.exec(p) ?? null, k = /^\/worlds\/([^/]+)\/knowledge$/.exec(p) ?? null;
            if (!route && m && method === 'GET') { route = ({ q }) => { const w = get_world(q('world')).world; return w.to_dict(find(w, params.address)); }; params.address = m[1]; }
            if (!route && k && method === 'GET') { route = () => ({ knowledge: get_world(params.wid).knowledge }); params.wid = k[1]; }
            if (!route) {
                const known = Object.keys(routes).some(r => r.split(' ')[1] === p) || m || k;
                throw new HttpError(known ? 405 : 404, known ? 'Method Not Allowed' : 'Not Found');
            }
            out = route({ q, body });
        } catch (e) {
            if (e instanceof HttpError) { status = e.status; out = { detail: e.detail }; } else { log.warning(`error: ${e.stack || e}`); status = 500; out = { detail: 'Internal Server Error' }; }
        }
        const headers = {};
        const wid = q('world');
        const lw = wid ? worlds.get(wid) : worlds.get(defaultId);
        if (lw) headers[VERSION_HEADER] = lw.version;
        return { status, headers, body: out };
    }

    return { handle, state, get worlds() { return worlds; }, defaultId };
}
