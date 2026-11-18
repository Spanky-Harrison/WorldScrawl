import { isNowhere, mightTable, normName } from '../shared/npc.mjs';
import { splitOptions } from './castdata.mjs';

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

// ---- The might-be-at list: a view over the one options string ("Market Lane, riverton:smithy(60), nowhere(20)").
/**
 * A might options line as chips, in the written order: [{raw, text, pct, share, kind, tag, address, name, id, dup}].
 * kind: room | area | region | stub | text (off-map words) | nowhere | unknown (an address on no map) | ambiguous | bad (not an option, shown raw).
 * `share` is the percent the odds table gives it (a blank percent splits what is left). `resolve` is castdata's placeResolver.
 * The returned array also carries `.table` (the shared odds table).
 */
export function optionChips(line, resolve = null, outline = null) {
    const parsed = splitOptions(line);
    const table = mightTable(parsed.filter(o => o.text).map(o => ({ text: o.text, pct: o.pct })));
    let ti = 0;
    const chips = parsed.map(o => {
        if (!o.text) return { raw: o.raw, text: null, pct: null, share: null, kind: 'bad', tag: '?' };
        const share = table.options[ti++]?.share ?? 0;
        if (isNowhere(o.text)) return { raw: o.raw, text: 'nowhere', pct: o.pct, share, kind: 'nowhere', tag: 'Nowhere', key: 'nowhere' };
        const r = resolve ? resolve(o.text) : { address: o.text, kind: o.text.includes(':') ? 'room' : 'text' };
        const base = { raw: o.raw, text: o.text, pct: o.pct, share, address: r.address, key: r.address };
        if (r.kind === 'room') return { ...base, kind: 'room', tag: 'place', id: r.address, name: placeLine(outline, 'room', r.address, resolve?.label).name };
        if (r.kind === 'area') { const region = r.level === 'region'; return { ...base, kind: region ? 'region' : 'area', tag: region ? 'region' : 'area', id: r.address, name: placeLine(outline, region ? 'region' : 'subregion', r.address, resolve?.label).name }; }
        if (r.kind === 'stub') return { ...base, kind: 'stub', tag: 'off the map', id: r.address, name: resolve?.label && resolve.label(r.address) !== r.address ? resolve.label(r.address) : '' };
        if (r.kind === 'text') return { ...base, kind: 'text', tag: 'off the map', key: normName(o.text) };
        return { ...base, kind: r.kind, tag: '?', matches: r.matches };
    });
    const count = new Map();
    for (const c of chips) if (c.key) count.set(c.key, (count.get(c.key) ?? 0) + 1);
    for (const c of chips) if (c.key && count.get(c.key) > 1) c.dup = true;
    chips.table = table;
    return chips;
}
/** Chips back to the options line: `text` or `text(pct)`, a chip that was not an option as written. */
export const chipsToLine = chips => chips.map(c => (c.kind === 'bad' ? c.raw : `${c.text}${c.pct != null ? `(${c.pct})` : ''}`)).join(', ');

let listSeq = 0;
/**
 * The might-be-at list control: one chip per option (kind tag, "Name - engine:id" or the words, a percent box, a remove button),
 * Add place… (the map in multi-pick mode), Add off the map…, Add Nowhere, the total, and the options as plain text.
 *   spec = { value: 'options line', resolve, outline, elsewhere: [{id,name}], title, onChange(line) }  (resolve/outline may be getters)
 * `.value` is the options line (get/set); every edit calls spec.onChange(line). The string is the single source of truth.
 */
export function pickList(doc, spec) {
    const mk = (tag, attrs = {}, ...kids) => { const e = doc.createElement(tag); for (const [k, v] of Object.entries(attrs)) { if (k === 'class') e.className = v; else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else if (v !== false && v !== null && v !== undefined) e.setAttribute(k, v === true ? '' : v); } e.append(...kids.filter(x => x !== null && x !== undefined && x !== false)); return e; };
    let line = String(spec.value ?? '');
    let chips = [];
    const list = mk('div', { class: 'cf-chips' });
    const total = mk('div', { class: 'cf-total muted' });
    const adder = mk('div', { class: 'cf-adder', hidden: true });
    const typed = mk('input', { type: 'text', class: 'pf-input cf-options', placeholder: 'Market Lane, General Store, nowhere(80)', title: 'The same list as text. A (number) is a percent.' });
    const addPlace = mk('button', { type: 'button', class: 'crumb cf-addplace', title: 'Open the map and pick rooms, areas or regions to add. Choose as many as you like, then press Done.' }, 'Add place…');
    const addOff = mk('button', { type: 'button', class: 'crumb cf-addoff', title: 'Add a place that is not on the map: a place from the world\'s off-map list, or plain words.' }, 'Add off the map…');
    const addNowhere = mk('button', { type: 'button', class: 'crumb cf-addnowhere', title: 'Add "nowhere": the share of the time they are not here at all.' }, 'Add Nowhere');
    const root = mk('div', { class: 'cf-picklist' }, list, mk('div', { class: 'cf-addrow' }, addPlace, addOff, addNowhere), adder, total,
        mk('details', { class: 'cf-typed' }, mk('summary', { title: 'Edit the list as text' }, 'Type it instead'), typed));
    const emit = () => spec.onChange?.(line);
    const rewrite = () => { line = chipsToLine(chips); typed.value = line; emit(); };
    const meta = () => {
        const fresh = optionChips(line, spec.resolve, spec.outline), tb = fresh.table;
        list.querySelectorAll('.cf-chip').forEach((r, i) => { const inp = r.querySelectorAll('.cf-pct')[0]; if (inp && fresh[i]) inp.setAttribute('placeholder', String(fresh[i].share ?? '')); });
        root.classList.toggle('over', tb.broken);
        total.textContent = !fresh.length ? '' : tb.broken ? `Total ${fresh.reduce((a, c) => a + (c.pct ?? 0), 0)}%, over 100.` : `Total ${tb.total}%.${tb.total < 100 ? ` The other ${100 - tb.total}% is nowhere.` : ''}`;
        addNowhere.disabled = fresh.some(c => c.kind === 'nowhere');
    };
    const draw = () => {
        chips = optionChips(line, spec.resolve, spec.outline);
        list.replaceChildren(...chips.map((c, i) => {
            const label = c.kind === 'bad' ? mk('span', { class: 'cf-chiplabel bad', title: 'Not an option' }, c.raw)
                : c.kind === 'nowhere' ? mk('span', { class: 'cf-chiplabel' }, 'Nowhere')
                : c.kind === 'text' ? mk('span', { class: 'cf-chiplabel', title: 'A place that is not on the map: plain words' }, c.text)
                : c.id ? mk('span', { class: 'cf-chiplabel', title: placeLine(spec.outline, c.kind === 'region' ? 'region' : c.kind === 'area' ? 'subregion' : 'room', c.id).path || c.id }, ...nameIdNodes(doc, { name: c.name, id: c.id }))
                : mk('span', { class: 'cf-chiplabel bad', title: c.kind === 'ambiguous' ? `Matches ${(c.matches ?? []).join(', ')}. Use the address.` : 'Not on the map yet' }, c.text);
            const pct = c.kind === 'bad' ? null : mk('input', { type: 'number', min: 0, max: 100, class: 'pf-input cf-pct', placeholder: String(c.share ?? ''), title: 'Percent of the time. Blank: share what is left of 100 with the other blank ones.' });
            if (pct && c.pct != null) pct.value = String(c.pct);
            if (pct) {
                pct.addEventListener('input', () => { chips[i].pct = pct.value === '' ? null : Math.round(+pct.value); rewrite(); meta(); });
                pct.addEventListener('change', () => draw());
            }
            const x = mk('button', { type: 'button', class: 'pf-x cf-chipx', title: 'Remove this one', onclick: () => { chips.splice(i, 1); rewrite(); draw(); } }, '✕');
            return mk('div', { class: `cf-chip cf-chip-${c.kind}${c.dup ? ' dup' : ''}${['unknown', 'ambiguous', 'bad'].includes(c.kind) ? ' bad' : ''}`, 'data-kind': c.kind, 'data-i': i },
                mk('span', { class: 'cf-chiptag', title: 'What kind of place this is' }, c.tag), label, ...(pct ? [pct, '%'] : []), x);
        }));
        meta();
    };
    const ids = () => chips.map(c => c.address).filter(Boolean);
    const addText = text => {
        const tx = String(text ?? '').trim(); if (!tx) return;
        const r = spec.resolve ? spec.resolve(tx) : null;
        const put = r && r.kind === 'stub' ? r.address : tx;
        chips.push(...optionChips(put, spec.resolve, spec.outline).filter(c => c.kind !== 'bad'));
        rewrite(); draw();
    };
    addPlace.addEventListener('click', async ev => {
        ev.preventDefault(); ev.stopPropagation();
        const pick = doc.defaultView?.wsPick;
        if (typeof pick !== 'function') return;
        const got = await pick({ kind: ['room', 'subregion', 'region'], multi: true, title: spec.title ?? 'places to add', outline: spec.outline, value: '', exclude: ids() });
        if (!Array.isArray(got)) return;
        const have = new Set(ids());
        for (const id of got) { if (have.has(id)) continue; have.add(id); chips.push(...optionChips(id, spec.resolve, spec.outline)); }
        rewrite(); draw();
    });
    addNowhere.addEventListener('click', ev => { ev.preventDefault(); ev.stopPropagation(); if (chips.some(c => c.kind === 'nowhere')) return; chips.push(...optionChips('nowhere', spec.resolve, spec.outline)); rewrite(); draw(); });
    const dlId = `cf-els-${++listSeq}`;
    addOff.addEventListener('click', ev => {
        ev.preventDefault(); ev.stopPropagation();
        const inp = mk('input', { type: 'text', class: 'pf-input cf-offname', list: dlId, placeholder: 'a fishing camp up the river', title: 'A place from the world\'s off-map list, or plain words.' });
        const ok = mk('button', { type: 'button', class: 'crumb cf-offadd', title: 'Add it to the list' }, 'Add');
        const no = mk('button', { type: 'button', class: 'crumb cf-offcancel', title: 'Do not add one' }, 'Cancel');
        const done = () => { adder.hidden = true; adder.replaceChildren(); };
        ok.addEventListener('click', e2 => { e2.preventDefault(); e2.stopPropagation(); const v = inp.value; done(); addText(v); });
        no.addEventListener('click', e2 => { e2.preventDefault(); e2.stopPropagation(); done(); });
        inp.addEventListener('keydown', e2 => { if (e2.key === 'Enter') { e2.preventDefault(); ok.click(); } });
        adder.hidden = false;
        adder.replaceChildren(inp, mk('datalist', { id: dlId }, ...(spec.elsewhere ?? []).map(x => mk('option', { value: x.name ?? x.id }))), ok, no);
    });
    typed.value = line;
    typed.addEventListener('input', () => { line = typed.value; emit(); meta(); });
    typed.addEventListener('change', () => draw());
    Object.defineProperty(root, 'value', { get: () => line, set: v => { line = String(v ?? ''); typed.value = line; draw(); } });
    root.chips = () => chips;
    draw();
    return root;
}
