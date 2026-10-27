// What the map's Edit place / Edit subregion / Edit region forms start from: the place's own settings (what the world
// file, plus this chat's changes, says), what each unset field inherits and from where, its exits with their pair's
// shared door, and the lists the dropdowns offer. Read-only; the form's Submit becomes patch ops (plugin/ui/placeform.mjs).
import { inspect } from './inspect.mjs';
import { FIELD_KEYS, EXIT_SIDE_KEYS, getRoom } from './ui/patches.mjs';

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const has = (o, k) => isObj(o) && Object.prototype.hasOwnProperty.call(o, k);
const pick = (o, keys) => Object.fromEntries(keys.filter(k => has(o, k)).map(k => [k, structuredClone(o[k])]));
const fromOf = src => (/^from (\w+)/.exec(src)?.[1] ?? (/subregion/.test(src) ? 'subregion' : 'default'));

function inheritedFrom(rows, keys, own) {
    const out = {};
    for (const k of keys) {
        if (has(own, k)) continue;
        const r = rows.find(x => x.key === k);
        if (r) out[k] = { value: r.value, from: fromOf(r.source) };
    }
    return out;
}
function expandInherit(levels) {
    for (const [name, o] of levels) if (isObj(o) && typeof o.expandable === 'boolean') return { value: o.expandable, from: name };
    return { value: true, from: 'default' };
}

export function editContext(w, worldJson, raw, target) {
    const t = String(target ?? '');
    const rooms = [...w.locations.values()].map(l => ({ address: l.address, name: l.name, area: l.address.slice(0, l.address.indexOf('/')), area_name: w.sub_of(l).name }));
    if (t.startsWith('sub:') || t.startsWith('region:')) {
        const sub = t.startsWith('sub:'), [rid, sid] = t.slice(sub ? 4 : 7).split(':');
        const rawR = raw[rid], rawS = sub ? rawR?.subregions?.[sid] : null, obj = sub ? rawS : rawR;
        if (!isObj(obj)) return null;
        const kind = sub ? 'subregion' : 'region', ins = inspect(w, [worldJson, raw], t);
        const own = pick(obj, ['name', 'notes', 'expandable', ...FIELD_KEYS[kind]]);
        const inherited = inheritedFrom(ins.resolved, FIELD_KEYS[kind].filter(k => k !== 'entrance'), own);
        if (!has(own, 'expandable')) inherited.expandable = expandInherit(sub ? [['region', rawR], ['world', worldJson]] : [['world', worldJson]]);
        const ent = ins.resolved.find(r => r.key === 'entrance');
        if (!has(own, 'entrance') && ent) inherited.entrance = { value: sub ? String(ent.value ?? '').split('/').pop() : String(ent.value ?? '').split(':').pop().split('/')[0], from: 'default' };
        // The entrance dropdown: a subregion's rooms (by id), or a region's subregions (by id).
        const entrances = sub ? Object.entries(rawS.locations ?? {}).map(([l, o]) => ({ value: l, label: o.name ?? l }))
            : Object.entries(rawR.subregions ?? {}).map(([s, o]) => ({ value: s, label: o.name ?? s }));
        return { kind, area: sub ? `${rid}:${sid}` : rid, title: obj.name ?? t, own, inherited, entrances };
    }
    const a = t.startsWith('loc:') ? t.slice(4) : t.startsWith('exit:') ? t.slice(5).split('|')[0] : t;
    const loc = w.get(a), r = getRoom(raw, a);
    if (!loc || !r) return null;
    const [rid, rest] = a.split(':'), sid = rest.split('/')[0];
    const rawR = raw[rid], rawS = rawR.subregions[sid];
    const ins = inspect(w, [worldJson, raw], a);
    const own = pick(r, ['name', 'description', 'expandable', ...FIELD_KEYS.room]);
    const inherited = inheritedFrom(ins.resolved, FIELD_KEYS.room, own);
    if (!has(own, 'inherit_region_notes')) inherited.inherit_region_notes = has(rawS, 'inherit_notes') ? { value: rawS.inherit_notes, from: 'subregion' } : { value: true, from: 'default' };
    if (!has(own, 'inherit_subregion_notes')) inherited.inherit_subregion_notes = { value: true, from: 'default' };
    if (!has(own, 'expandable')) inherited.expandable = expandInherit([['subregion', rawS], ['region', rawR], ['world', worldJson]]);
    const exits = (r.exits ?? []).filter(isObj).map(e => {
        const backRoom = getRoom(raw, e.to), back = backRoom ? (backRoom.exits ?? []).find(x => isObj(x) && x.to === a) ?? null : null;
        const barrier = isObj(e.barrier) ? e.barrier : isObj(back?.barrier) ? back.barrier : null;
        return { direction: e.direction, to: e.to, to_name: backRoom?.name ?? e.to, side: pick(e, EXIT_SIDE_KEYS), travel_time: e.travel_time ?? null,
            barrier: barrier ? structuredClone(barrier) : null, back_direction: back?.direction ?? null };
    });
    return { kind: 'room', address: a, area: `${rid}:${sid}`, title: r.name, own, inherited, exits,
        subregions: Object.entries(rawR.subregions ?? {}).map(([s, o]) => ({ area: `${rid}:${s}`, name: o.name ?? s })),
        rooms: rooms.filter(x => x.address !== a) };
}
