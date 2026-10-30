// What the map's Edit place / Edit subregion / Edit region forms start from: the place's own settings (what the world
// file, plus this chat's changes, says), what each unset field inherits and from where, its exits with their pair's
// shared door, and the lists the dropdowns offer. Read-only; the form's Submit becomes patch ops (plugin/ui/placeform.mjs).
import { inspect } from './inspect.mjs';
import { flipBar } from './ui/doorbar.mjs';
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
        const own = pick(obj, ['name', 'lore', 'expandable', ...FIELD_KEYS[kind]]);
        const inherited = inheritedFrom(ins.resolved, FIELD_KEYS[kind].filter(k => k !== 'entrance'), own);
        if (!has(own, 'expandable')) inherited.expandable = expandInherit(sub ? [['region', rawR], ['world', worldJson]] : [['world', worldJson]]);
        const ent = ins.resolved.find(r => r.key === 'entrance');
        if (!has(own, 'entrance') && ent) inherited.entrance = { value: sub ? String(ent.value ?? '').split('/').pop() : String(ent.value ?? '').split(':').pop().split('/')[0], from: 'default' };
        // The entrance dropdown: a subregion's rooms (by id), or a region's subregions (by id).
        const entrances = sub ? Object.entries(rawS.locations ?? {}).map(([l, o]) => ({ value: l, label: o.name ?? l }))
            : Object.entries(rawR.subregions ?? {}).map(([s, o]) => ({ value: s, label: o.name ?? s }));
        // Notes stack (they are additive, not overridden): a subregion's own notes sit under its region's.
        const parent_notes = sub && rawR?.lore ? [{ from: 'region', name: rawR.name ?? rid, text: String(rawR.lore), toggle: 'inherit_lore' }] : [];
        return { kind, area: sub ? `${rid}:${sid}` : rid, title: obj.name ?? t, own, inherited, entrances, parent_notes };
    }
    if (t.startsWith('new:')) return createContext(w, worldJson, raw, t.slice(4), rooms);
    const a = t.startsWith('loc:') ? t.slice(4) : t.startsWith('exit:') ? t.slice(5).split('|')[0] : t;
    const loc = w.get(a), r = getRoom(raw, a);
    if (!loc || !r) return null;
    const [rid, rest] = a.split(':'), sid = rest.split('/')[0];
    const rawR = raw[rid], rawS = rawR.subregions[sid];
    const ins = inspect(w, [worldJson, raw], a);
    const own = pick(r, ['name', 'description', 'expandable', ...FIELD_KEYS.room]);
    const inherited = inheritedFrom(ins.resolved, FIELD_KEYS.room, own);
    if (!has(own, 'inherit_region_lore')) inherited.inherit_region_lore = has(rawS, 'inherit_lore') ? { value: rawS.inherit_lore, from: 'subregion' } : { value: true, from: 'default' };
    if (!has(own, 'inherit_subregion_lore')) inherited.inherit_subregion_lore = { value: true, from: 'default' };
    if (!has(own, 'expandable')) inherited.expandable = expandInherit([['subregion', rawS], ['region', rawR], ['world', worldJson]]);
    const exits = (r.exits ?? []).filter(isObj).map(e => {
        const backRoom = getRoom(raw, e.to), back = backRoom ? (backRoom.exits ?? []).find(x => isObj(x) && x.to === a) ?? null : null;
        const barrier = isObj(e.barrier) ? e.barrier : isObj(back?.barrier) ? flipBar(back.barrier) : null; // shown from this side
        return { direction: e.direction, to: e.to, to_name: backRoom?.name ?? e.to, side: pick(e, EXIT_SIDE_KEYS), travel_time: e.travel_time ?? null,
            barrier: barrier ? structuredClone(barrier) : null, back_direction: back?.direction ?? null, back_side: back ? pick(back, EXIT_SIDE_KEYS) : null };
    });
    return { kind: 'room', address: a, area: `${rid}:${sid}`, title: r.name, own, inherited, exits,
        subregions: Object.entries(rawR.subregions ?? {}).map(([s, o]) => ({ area: `${rid}:${s}`, name: o.name ?? s })),
        rooms: rooms.filter(x => x.address !== a),
        // The parent notes stacked on top of this place's own description (each with its inherit toggle).
        parent_notes: [
            ...(rawR?.lore ? [{ from: 'region', name: rawR.name ?? rid, text: String(rawR.lore), toggle: 'inherit_region_lore' }] : []),
            ...(rawS?.lore ? [{ from: 'subregion', name: rawS.name ?? sid, text: String(rawS.lore), toggle: 'inherit_subregion_lore' }] : []),
        ] };
}

/**
 * Create place: the Edit place form, empty, for a new place in subregion `area` ("region:sub"). Unset fields show
 * what the new place would inherit from its subregion and region.
 */
function createContext(w, worldJson, raw, area, rooms) {
    const [rid, sid] = String(area).split(':'), rawR = raw[rid], rawS = rawR?.subregions?.[sid];
    if (!isObj(rawS)) return null;
    const ins = inspect(w, [worldJson, raw], `sub:${area}`);
    const inherited = inheritedFrom(ins?.resolved ?? [], FIELD_KEYS.room.filter(k => !/^inherit_/.test(k)), {});
    inherited.inherit_region_lore = has(rawS, 'inherit_lore') ? { value: rawS.inherit_lore, from: 'subregion' } : { value: true, from: 'default' };
    inherited.inherit_subregion_lore = { value: true, from: 'default' };
    inherited.expandable = expandInherit([['subregion', rawS], ['region', rawR], ['world', worldJson]]);
    return { kind: 'room', create: true, address: null, area, title: 'New place', own: {}, inherited, exits: [],
        subregions: Object.entries(rawR.subregions ?? {}).map(([s, o]) => ({ area: `${rid}:${s}`, name: o.name ?? s })),
        rooms,
        parent_notes: [
            ...(rawR?.lore ? [{ from: 'region', name: rawR.name ?? rid, text: String(rawR.lore), toggle: 'inherit_region_lore' }] : []),
            ...(rawS?.lore ? [{ from: 'subregion', name: rawS.name ?? sid, text: String(rawS.lore), toggle: 'inherit_subregion_lore' }] : []),
        ] };
}

/** Every region, subregion and place (ids and names): the map's wizards and Move / Delete dialogs pick from it. */
export function outline(raw) {
    return Object.entries(raw).filter(([, r]) => isObj(r)).map(([rid, r]) => ({
        id: rid, name: r.name ?? rid,
        subregions: Object.entries(r.subregions ?? {}).filter(([, s]) => isObj(s)).map(([sid, s]) => ({
            id: sid, area: `${rid}:${sid}`, name: s.name ?? sid,
            rooms: Object.entries(s.locations ?? {}).filter(([, l]) => isObj(l)).map(([lid, l]) => ({ id: lid, address: `${rid}:${sid}/${lid}`, name: l.name ?? lid })),
        })),
    }));
}

const short = t => { const s = String(t ?? '').trim().replace(/\s+/g, ' '); const m = /^(.{20,200}?[.!?])(\s|$)/.exec(s); return m ? m[1] : s.slice(0, 200); };
/**
 * What "Expand with AI" may see: only the parent region and subregion (names and notes) and the names and first
 * sentences of the places the exits connect to. Never the rest of the world.
 * area: "region:sub" or "region"; rooms: addresses the exits lead to.
 */
export function aiContext(raw, area, rooms = []) {
    const [rid, sid] = String(area ?? '').split(':'), r = raw[rid], s = sid ? r?.subregions?.[sid] : null;
    const neighbors = [...new Set(rooms)].slice(0, 12).map(a => getRoom(raw, a) ? { name: getRoom(raw, a).name ?? a, short: short(getRoom(raw, a).description) } : null).filter(Boolean);
    return { region: isObj(r) ? { name: r.name ?? rid, lore: r.lore ?? '' } : null, subregion: isObj(s) ? { name: s.name ?? sid, lore: s.lore ?? '' } : null, neighbors };
}
