// Map-based pickers: every "pick a region / subregion / place" field is a small control showing the current value with
// its full path and a "Choose…" button. Choose… hands the field's spec to the map window (doc.defaultView.wsPick),
// which suspends the form (its DOM, and so every unsaved value, is kept as is), enters pick mode and resolves with the
// chosen id, or null on Cancel. Pure DOM, no server calls: names and paths come from the outline passed in.
//   spec = { kind: 'room'|'subregion'|'region', title: 'exit destination', value, exclude: [ids], allowed: [ids] | null,
//            outline: {regions:[{id,name,subregions:[{id,area,name,rooms:[{address,name}]}]}]}, empty: 'label for no value',
//            clearable: bool, label: 'nameId' (opt-in: show "Display Name - engine:id" on one line, the path in the tooltip),
//            nameOf: (id) => display name when the outline has none (the first paint, a test) }
// `kind` may also be an array of kinds (multi-pick: the map's pick mode with `multi: true` resolves with an array of ids;
// every spec without `multi` resolves with one id string, or null on Cancel).
// The returned element behaves like a <select> for its callers: .value (get/set) and a bubbling 'change' event.

/** Every entity of a kind in an outline, with its display path: [{id, name, path, kind}]. */
export function pickEntries(outline, kind) {
    if (Array.isArray(kind)) return kind.flatMap(k => pickEntries(outline, k));
    const out = [];
    for (const r of outline?.regions ?? []) {
        if (kind === 'region') { out.push({ id: r.id, name: r.name, path: r.name, kind }); continue; }
        for (const s of r.subregions ?? []) {
            const area = s.area ?? `${r.id}:${s.id}`;
            if (kind === 'subregion') { out.push({ id: area, name: s.name, path: `${r.name} › ${s.name}`, kind }); continue; }
            for (const x of s.rooms ?? []) out.push({ id: x.address, name: x.name, path: `${r.name} › ${s.name} › ${x.name}`, kind });
        }
    }
    return out;
}
/** Which ids a spec accepts. */
export function pickValid(spec, id) {
    if (!id) return false;
    if ((spec.exclude ?? []).includes(id)) return false;
    if (spec.allowed && !spec.allowed.includes(id)) return false;
    return pickEntries(spec.outline, spec.kind).some(e => e.id === id);
}
/** Search an outline for a pick: name or path contains every word; exact-name and prefix matches first. */
export function pickSearch(spec, q, limit = 30) {
    const words = String(q ?? '').toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return [];
    const ql = words.join(' ');
    return pickEntries(spec.outline, spec.kind).filter(e => words.every(w => e.path.toLowerCase().includes(w)))
        .map(e => ({ ...e, valid: pickValid(spec, e.id), rank: e.name.toLowerCase() === ql ? 0 : e.name.toLowerCase().startsWith(ql) ? 1 : 2 }))
        .sort((a, b) => a.rank - b.rank || a.path.localeCompare(b.path)).slice(0, limit);
}
export const pathOf = (outline, kind, id) => pickEntries(outline, kind).find(e => e.id === id)?.path ?? null;
/**
 * One place for display: {name, id, path}. The name comes from the outline, else `fallbackName` (a string or (id) => string:
 * the cast panel's own place labels, for the first paint and tests with no outline), else '' (then the line is just the id).
 */
export function placeLine(outline, kind, id, fallbackName = '') {
    const hit = id ? pickEntries(outline, kind).find(e => e.id === id) : null;
    const fb = typeof fallbackName === 'function' ? fallbackName(id) : fallbackName;
    return { name: hit?.name ?? (fb && fb !== id ? String(fb) : ''), id: id ?? '', path: hit?.path ?? '' };
}
/** The one-line "Display Name - engine:id" label as DOM nodes (the id is its own selectable element). */
export function nameIdNodes(doc, line) {
    const out = [];
    if (line.name) { const n = doc.createElement('span'); n.className = 'wspick-name'; n.textContent = line.name; out.push(n, doc.createTextNode(' - ')); }
    const c = doc.createElement('code'); c.className = 'wspick-id'; c.textContent = line.id; out.push(c);
    return out;
}

export function pickField(doc, spec) {
    const mk = (tag, attrs = {}, ...kids) => { const e = doc.createElement(tag); for (const [k, v] of Object.entries(attrs)) { if (k === 'class') e.className = v; else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else if (v !== false && v !== null && v !== undefined) e.setAttribute(k, v === true ? '' : v); } e.append(...kids.filter(x => x !== null && x !== undefined && x !== false)); return e; };
    let value = spec.value ?? '';
    const shown = mk('span', { class: 'wspick-value' });
    const choose = mk('button', { type: 'button', class: 'crumb wspick-choose', title: `Pick the ${spec.title ?? spec.kind} on the map` }, 'Choose…');
    const clear = mk('button', { type: 'button', class: 'crumb wspick-clear', title: 'Clear' }, '✕');
    const root = mk('span', { class: 'wspick', 'data-kind': Array.isArray(spec.kind) ? spec.kind.join(' ') : spec.kind }, shown, choose, ...(spec.clearable ? [clear] : []));
    const draw = () => {
        if (spec.label === 'nameId' && value) {
            const line = placeLine(spec.outline, spec.kind, value, spec.nameOf);
            shown.replaceChildren(...nameIdNodes(doc, line));
            shown.title = line.path ? `${line.path}\n${value}` : value;
        } else {
            const p = value ? pathOf(spec.outline, spec.kind, value) ?? value : '';
            shown.textContent = p || (spec.empty ?? `(no ${spec.kind === 'room' ? 'place' : spec.kind} chosen)`);
            shown.title = value || '';
        }
        shown.classList.toggle('muted', !value); root.dataset.value = value;
        clear.hidden = !value;
    };
    const set = (v, fire = true) => { value = v ?? ''; draw(); if (fire) { root.dispatchEvent(new Event('input', { bubbles: true })); root.dispatchEvent(new Event('change', { bubbles: true })); } };
    Object.defineProperty(root, 'value', { get: () => value, set: v => set(v, false) });
    root.setValue = v => set(v); // a programmatic pick (fires change, as a real pick does)
    root.spec = spec;
    choose.addEventListener('click', async ev => {
        ev.preventDefault(); ev.stopPropagation();
        const pick = doc.defaultView?.wsPick;
        if (typeof pick !== 'function') return;
        const v = await pick({ ...spec, value });
        if (v !== null && v !== undefined) set(v);
    });
    clear.addEventListener('click', ev => { ev.preventDefault(); ev.stopPropagation(); set(''); });
    draw();
    return root;
}
