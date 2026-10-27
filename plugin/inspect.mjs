// Read-only inspector data for the map window's Editor mode: the raw JSON of a world / region / subregion / room / exit,
// its resolved values (after the world -> region -> subregion -> room cascade) labelled with where each one came from,
// and the loader's warnings that mention it. Never writes anything.
import { BARRIER_DEFAULTS, EXIT_TYPES, World, has, isObj } from './world.mjs';
import { PLACE_FIELDS } from './weather-config.mjs';

const lc = s => String(s).toLowerCase();
const HEAT = ['indoor_temp', 'insulation', 'fixed_weather'];
const PLACE_DEFAULTS = { exposure: 'outdoor', indoor_temp: null, insulation: 'normal', fixed_weather: null };
const row = (key, value, source) => ({ key, value: value === undefined ? null : value, source });

/** Every place in the world, for Editor mode (shows the whole map, not just what a chat has found). */
export function inspectIndex(w) {
    const doors = new Set();
    for (const l of w.locations.values()) for (const e of l.exits) if (e.door) doors.add(e.door);
    return { addresses: [...w.locations.keys()], doors: [...doors], warnings: (w.warnings ?? []).length };
}

/** A copy of a raw object with one big child collapsed to its keys (so a region doesn't dump every room). */
const collapse = (o, k) => (isObj(o) && isObj(o[k]) ? { ...o, [k]: Object.fromEntries(Object.keys(o[k]).map(x => [x, '…'])) } : o);

function rawLevels(raw, w, loc) {
    const region = raw[1][loc.region], sub = region?.subregions?.[loc.subregion], room = sub?.locations?.[loc.id];
    return [['room', room ?? {}], ['subregion', sub ?? {}], ['region', region ?? {}]];
}

/** Weather/exposure fields of a room with their source level (same rules as World.place_weather). */
export function placeRows(raw, w, loc) {
    const chain = rawLevels(raw, w, loc);
    const top = chain.findIndex(([, o]) => has(o, 'exposure')), own = top < 0 ? chain : chain.slice(0, top + 1);
    const out = [];
    for (const k of PLACE_FIELDS) {
        if (k === 'temp_offset') {
            const parts = chain.filter(([, o]) => has(o, k));
            const sum = parts.reduce((a, [, o]) => a + o.temp_offset, 0);
            out.push(row(k, sum, parts.length ? parts.map(([lvl, o]) => `${lvl} ${o.temp_offset > 0 ? '+' : ''}${o.temp_offset}`).join(', ') : 'default'));
            continue;
        }
        const list = HEAT.includes(k) ? own : chain, hit = list.find(([, o]) => has(o, k));
        out.push(hit ? row(k, hit[1][k], hit[0] === 'room' ? 'own' : `from ${hit[0]}`) : row(k, PLACE_DEFAULTS[k], 'default'));
    }
    const region = raw[1][loc.region] ?? {};
    out.unshift(row('weather_region', w.regions.get(loc.region).weather_region ?? null, has(region, 'weather_region') ? 'from region' : 'default'));
    return out;
}

function stays(w, rawLvls) {
    const hit = rawLvls.find(([, o]) => has(o, 'stays_open'));
    return hit ? row('stays_open', hit[1].stays_open, hit[0] === 'room' ? 'own' : `from ${hit[0]}`) : row('stays_open', false, 'default');
}

const warningsFor = (w, refs) => (w.warnings ?? []).filter(x => x.refs.some(r => refs.includes(r)));

/** Find an exit by "address|direction". */
export function findExit(w, ref) {
    const i = ref.lastIndexOf('|'), loc = w.get(ref.slice(0, i));
    const e = loc?.exits.find(x => lc(x.direction) === lc(ref.slice(i + 1))) ?? null;
    return e ? { loc, e } : null;
}

export function exitRows(w, loc, e) {
    const given = isObj(e.raw) ? e.raw : {}, preset = EXIT_TYPES[e.type] ?? {};
    const lvl = k => (has(given, k) ? 'own' : has(given, 'view') && (k === 'sight' || k === 'sound') && given.view === 'none' ? 'own (legacy "view": "none")' : has(preset, k) ? `from type "${e.type}"` : 'default');
    const rows = [row('to', e.to, 'own'), row('type', e.type, has(given, 'type') ? 'own' : 'default'), row('sight', e.sight, e.flags.obscured && given.sight !== 'none' ? 'obscured (always none)' : lvl('sight')),
        row('sound', e.sound, lvl('sound')), row('travel_time', w.travel_seconds(e, loc), has(given, 'travel_time') ? `own ("${given.travel_time}")` : 'default'),
        ...['hidden', 'obscured', 'one_way'].map(f => row(f, !!e.flags[f], has(given, f) ? 'own' : 'default')),
        row('description', e.description, e.description ? 'own' : 'default'), row('traversal', e.traversal, e.traversal ? 'own' : 'default')];
    if (e.barrier) {
        const primary = e.barrier_from && e.barrier_from !== loc.address ? w.get(e.barrier_from) : null;
        const pe = primary?.exits.find(x => x.to === loc.address) ?? null;
        const pGiven = (pe?.raw && isObj(pe.raw.barrier)) ? pe.raw.barrier : {};
        const from = primary ? `from ${primary.name} side (${pe?.direction ?? '?'})` : null;
        const bGiven = isObj(given.barrier) ? given.barrier : {};
        for (const k of Object.keys(BARRIER_DEFAULTS)) {
            let src;
            if (k === 'closed_sight' && e.flags.obscured) src = 'obscured (always none)';
            else if (from) src = has(pGiven, k) ? from : `${from}; default value`;
            else if (has(bGiven, k)) src = 'own';
            else if (e.legacy_view) src = 'legacy "view": "closed"';
            else if (isObj(preset.barrier) && has(preset.barrier, k)) src = `from type "${e.type}"`;
            else src = 'default';
            rows.push(row(`barrier.${k}`, e.barrier[k], src));
        }
        const so = w.stays_open(e, loc);
        rows.push(row('barrier.stays_open', so, has(bGiven, 'stays_open') || has(given, 'stays_open') ? 'own' : 'shared by both sides / inherited'));
        rows.push(row('barrier (primary side)', e.barrier_from, e.barrier_from === loc.address ? (e.barrier_own ? 'this side' : 'this side (hidden/obscured exit, own side only)') : 'the other side'));
        if (!e.barrier_from) rows[rows.length - 1] = row('barrier (primary side)', loc.address, 'this side only (hidden/obscured exit)');
        rows.push(row('door', e.door, 'derived'), row('blocked', e.blocked, 'derived'));
    } else rows.push(row('barrier', null, 'none'));
    return rows;
}

/**
 * target: "world" | "region:<id>" | "sub:<region>:<sub>" | "<region>:<sub>/<loc>" (a room) | "exit:<address>|<direction>".
 * Returns {target, kind, title, raw, resolved: [{key, value, source}], warnings: [{message}]}, or null if not found.
 */
export function inspect(w, raw, target) {
    const t = String(target ?? '');
    const [worldJson, regionsRaw] = raw;
    const out = (kind, title, rawObj, resolved, refs) => ({ target: t, kind, title, raw: rawObj, resolved, warnings: warningsFor(w, refs).map(x => ({ message: x.message })) });
    if (t === 'world' || t === '') {
        const rows = [row('start', w.start, 'own'), row('regions', w.regions.size, 'derived'), row('rooms', w.locations.size, 'derived'),
            row('temperature_unit', w.weather?.unit ?? 'F', has(worldJson, 'temperature_unit') ? 'own' : 'default'),
            row('calendar', has(worldJson, 'calendar') ? 'custom' : 'Gregorian', has(worldJson, 'calendar') ? 'own' : 'default')];
        return { ...out('world', worldJson.name ?? 'World', worldJson, rows, ['world']), warnings: (w.warnings ?? []).map(x => ({ message: x.message })) };
    }
    if (t.startsWith('region:')) {
        const id = t.slice(7), r = w.regions.get(id);
        if (!r) return null;
        const rawR = regionsRaw[id] ?? {}, lv = [['region', rawR]];
        const rows = [row('name', r.name, 'own'), row('entrance', r.entrance, has(rawR, 'entrance') ? 'own' : 'default (start)'), row('notes', r.notes, r.notes ? 'own' : 'default'),
            row('weather_region', r.weather_region, has(rawR, 'weather_region') ? 'own' : 'default'), ...PLACE_FIELDS.map(k => row(k, has(rawR, k) ? rawR[k] : k === 'temp_offset' ? 0 : PLACE_DEFAULTS[k], has(rawR, k) ? 'own' : 'default')), stays(w, lv)];
        return out('region', r.name, collapse(rawR, 'subregions'), rows, [`region:${id}`, ...[...w.locations.keys()].filter(a => a.startsWith(`${id}:`)).map(a => `loc:${a}`)]);
    }
    if (t.startsWith('sub:')) {
        const [rid, sid] = t.slice(4).split(':'), s = w.subregions.get(`${rid}:${sid}`);
        if (!s) return null;
        const rawR = regionsRaw[rid] ?? {}, rawS = rawR.subregions?.[sid] ?? {};
        const lv = [['subregion', rawS], ['region', rawR]];
        const top = lv.findIndex(([, o]) => has(o, 'exposure')), own = top < 0 ? lv : lv.slice(0, top + 1);
        const pick = (k, list = lv) => { const h = list.find(([, o]) => has(o, k)); return h ? row(k, h[1][k], h[0] === 'subregion' ? 'own' : `from ${h[0]}`) : row(k, k in PLACE_DEFAULTS ? PLACE_DEFAULTS[k] : 0, 'default'); };
        const rows = [row('name', s.name, 'own'), row('entrance', s.entrance, has(rawS, 'entrance') ? 'own' : 'default (first room)'), row('notes', s.notes, s.notes ? 'own' : 'default'),
            row('inherit_notes', s.inherit_notes, has(rawS, 'inherit_notes') ? 'own' : 'default'),
            row('weather_region', w.regions.get(rid).weather_region, has(rawR, 'weather_region') ? 'from region' : 'default'),
            ...PLACE_FIELDS.map(k => pick(k, HEAT.includes(k) ? own : lv)), stays(w, lv)];
        return out('subregion', s.name, collapse(rawS, 'locations'), rows, [`sub:${rid}:${sid}`, ...[...w.locations.keys()].filter(a => a.startsWith(`${rid}:${sid}/`)).map(a => `loc:${a}`)]);
    }
    if (t.startsWith('exit:')) {
        const f = findExit(w, t.slice(5));
        if (!f) return null;
        const { loc, e } = f, back = w.get(e.to)?.exits.find(x => x.to === loc.address) ?? null;
        const refs = [t.slice(0, 5) + `${loc.address}|${lc(e.direction)}`, ...(back ? [`exit:${e.to}|${lc(back.direction)}`] : [])];
        return out('exit', `${loc.name}: ${e.direction}`, e.raw, exitRows(w, loc, e), refs);
    }
    const loc = w.get(t);
    if (!loc) return null;
    const notes = w.effective_notes(loc), sub = w.sub_of(loc), region = w.regions.get(loc.region);
    const lv = rawLevels(raw, w, loc);
    const rows = [row('name', loc.name, 'own'), row('display_name', World.place_label(loc.name, sub.name), 'derived'),
        row('region notes', notes.region, notes.region ? 'from region' : 'not inherited'), row('subregion notes', notes.subregion, notes.subregion ? 'from subregion' : 'not inherited'),
        ...placeRows(raw, w, loc), stays(w, lv), row('exits', loc.exits.map(e => e.direction), 'own'), row('views', loc.views, loc.views.length ? 'own' : 'default')];
    void region;
    return out('room', World.place_label(loc.name, sub.name), lv[0][1], rows, [`loc:${loc.address}`, ...loc.exits.map(e => `exit:${loc.address}|${lc(e.direction)}`)]);
}
