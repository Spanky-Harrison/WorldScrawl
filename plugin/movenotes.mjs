// What a moved place starts or stops inheriting from its new parents (notes, climate, exposure...): compared on the
// effective values before and after the move, so only categories that actually differ are listed. Read-only.
const CATS = [
    ['notes', (w, l) => { const n = w.effective_notes(l); return [n.region ?? null, n.subregion ?? null]; }],
    ['climate', (w, l) => { const p = w.place_weather(l); return [p.weather_region ?? null, p.fixed_weather ?? null]; }],
    ['exposure', (w, l) => w.place_weather(l).exposure],
    ['temperature', (w, l) => { const p = w.place_weather(l); return [p.indoor_temp, p.temp_offset]; }],
    ['insulation', (w, l) => w.place_weather(l).insulation],
    ['expandable', (w, l) => l.expandable !== false],
    ['door behaviour', (w, l) => w.inherited_stays_open(l)],
];
/** {oldAddress: {changed: [category...], from, to}} for each moved (not merged) place whose inherited values change. */
export function inheritNotes(wb, wa, relocate = {}) {
    const out = {};
    for (const [o, n] of Object.entries(relocate ?? {})) {
        const a = wb.get(o), b = wa.get(n);
        if (!a || !b || wb.get(n)) continue; // a merge into a place that already existed
        const changed = CATS.filter(([, f]) => JSON.stringify(f(wb, a)) !== JSON.stringify(f(wa, b))).map(([c]) => c);
        if (!changed.length) continue;
        const sameRegion = a.region === b.region;
        const name = (w, l) => sameRegion ? w.sub_of(l).name : w.regions.get(l.region).name;
        out[o] = { changed, from: name(wb, a), to: name(wa, b) };
    }
    return out;
}
/** Readable names for the containers a move touches ({"larkspur": "Larkspur", "riverton:streets": "Streets"}), old and new. */
export function moveNames(wb, wa, relocate = {}) {
    const out = {};
    for (const [o, n] of Object.entries(relocate ?? {})) for (const [w, a] of [[wb, o], [wa, n]]) {
        const l = w.get(a); if (!l) continue;
        out[l.region] ??= w.regions.get(l.region)?.name ?? l.region;
        out[`${l.region}:${l.subregion}`] ??= w.sub_of(l)?.name ?? l.subregion;
    }
    return out;
}
