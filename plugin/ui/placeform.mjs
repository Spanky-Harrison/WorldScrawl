// The map's Edit place / Edit subregion / Edit region forms. Pure parts (the field specs and the diff that turns a
// form into patch ops) are node-tested; buildEditForm makes the DOM. The form starts from /edit/context: `own` holds
// what the place itself sets, `inherited` what an unset field gets and from where. Only fields the user explicitly
// changed become ops, so submitting an untouched form never copies inherited values into the place.
import { FIELD_KEYS, EXIT_SIDE_KEYS, ENUMS } from './patches.mjs';

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const has = (o, k) => isObj(o) && Object.prototype.hasOwnProperty.call(o, k);
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const str = v => (typeof v === 'string' ? v.trim() : '');

/** Field specs: type text | textarea | bool | number | choice (radio for 2-3 options, a dropdown for 4+). */
export const ROOM_FIELDS = [
    { k: 'name', type: 'text', label: 'Name', required: true },
    { k: 'description', type: 'textarea', label: 'Description', required: true, ai: true },
    { k: 'expandable', type: 'bool', label: 'New rooms can be discovered here' },
    { k: 'inherit_region_notes', type: 'bool', label: 'Uses the region notes' },
    { k: 'inherit_subregion_notes', type: 'bool', label: 'Uses the subregion notes' },
    { k: 'exposure', type: 'choice', label: 'Exposure', options: ENUMS.exposure },
    { k: 'insulation', type: 'choice', label: 'Insulation', options: ENUMS.insulation },
    { k: 'indoor_temp', type: 'number', label: 'Indoor temperature' },
    { k: 'temp_offset', type: 'number', label: 'Temperature offset' },
];
export const AREA_FIELDS = {
    subregion: [
        { k: 'name', type: 'text', label: 'Name', required: true },
        { k: 'notes', type: 'textarea', label: 'Notes', ai: true },
        { k: 'entrance', type: 'choice', label: 'Entrance', options: 'entrances' },
        { k: 'expandable', type: 'bool', label: 'New rooms can be discovered here' },
        { k: 'inherit_notes', type: 'bool', label: 'Rooms use the region notes' },
        { k: 'label_rooms', type: 'bool', label: 'Room names carry the subregion name', dflt: false },
        { k: 'stays_open', type: 'bool', label: 'Doors stay open' },
        { k: 'exposure', type: 'choice', label: 'Exposure', options: ENUMS.exposure },
        { k: 'insulation', type: 'choice', label: 'Insulation', options: ENUMS.insulation },
        { k: 'indoor_temp', type: 'number', label: 'Indoor temperature' },
        { k: 'temp_offset', type: 'number', label: 'Temperature offset' },
    ],
    region: [
        { k: 'name', type: 'text', label: 'Name', required: true },
        { k: 'notes', type: 'textarea', label: 'Notes', ai: true },
        { k: 'entrance', type: 'choice', label: 'Entrance', options: 'entrances' },
        { k: 'expandable', type: 'bool', label: 'New rooms can be discovered here' },
        { k: 'stays_open', type: 'bool', label: 'Doors stay open' },
        { k: 'exposure', type: 'choice', label: 'Exposure', options: ENUMS.exposure },
        { k: 'insulation', type: 'choice', label: 'Insulation', options: ENUMS.insulation },
        { k: 'indoor_temp', type: 'number', label: 'Indoor temperature' },
        { k: 'temp_offset', type: 'number', label: 'Temperature offset' },
    ],
};
/** One exit block. `shared` fields are the pair's (they change both sides); the rest are this side's only. */
export const EXIT_FIELDS = [
    { k: 'direction', type: 'text', label: 'Direction', required: true },
    { k: 'description', type: 'textarea', label: 'Description (this side)', ai: true },
    { k: 'travel_time', type: 'text', label: 'Travel time (both ways)', shared: true },
    { k: 'type', type: 'choice', label: 'Type', options: ENUMS.type, dflt: 'portal' },
    { k: 'sight', type: 'choice', label: 'See destination', options: ENUMS.sight },
    { k: 'sound', type: 'choice', label: 'Hear destination', options: ENUMS.sound },
    { k: 'traversal', type: 'text', label: 'Traversal (e.g. climb, swim)' },
    { k: 'hidden', type: 'bool', label: 'Hidden', dflt: false },
    { k: 'obscured', type: 'bool', label: 'Obscured', dflt: false },
];
export const DOOR_FIELDS = [
    { k: 'openable', type: 'bool', label: 'Can be opened', dflt: true },
    { k: 'locked', type: 'bool', label: 'Locked', dflt: false },
    { k: 'starts_open', type: 'bool', label: 'Starts open', dflt: false },
    { k: 'closed_sight', type: 'choice', label: 'See destination', options: ENUMS.closed_sight, dflt: 'none' },
    { k: 'closed_sound', type: 'choice', label: 'Hear destination', options: ENUMS.closed_sound, dflt: 'partial' },
];

/** What an exit's unset sight/sound comes to while open (or with no door), and why (obscured, exit type), from the form's live state. */
export function exitLevelDefault(e, k) {
    const side = e.side ?? {};
    if (k === 'sight' && side.obscured === true) return { value: 'none', from: 'default' };
    return { value: { portal: 'partial', open: 'clear' }[side.type ?? 'portal'] ?? 'partial', from: 'default' }; // the open / no-door value // the open / no-door value; a closed door uses the door's closed_sight / closed_sound
}

/** The form's starting state: a copy of what the place itself sets (inherited fields stay unset). */
export function initialState(ctx) {
    const s = { own: structuredClone(ctx.own ?? {}) };
    if (ctx.kind === 'room') {
        s.area = ctx.area;
        s.exits = (ctx.exits ?? []).map(e => ({ orig: e.direction, to: e.to, to_name: e.to_name, side: structuredClone(e.side ?? {}),
            travel_time: e.travel_time ?? undefined, barrier: e.barrier === null ? null : structuredClone(e.barrier), removed: false }));
    }
    return s;
}
/** A blank exit block for "Add exit". */
export const newExit = () => ({ orig: null, to: '', side: {}, travel_time: undefined, barrier: null, return_direction: '', return_description: '', removed: false });

function fieldDiff(before, after, keys) {
    const f = {};
    for (const k of keys) if (!same(before[k], after[k])) f[k] = has(after, k) && after[k] !== undefined && after[k] !== '' ? after[k] : null;
    return f;
}
/** The patch ops for a room form: only what differs from the context it started from. */
export function placeOps(ctx, state) {
    const a = ctx.address, b = ctx.own ?? {}, o = state.own ?? {}, ops = [];
    if (str(o.name) && str(o.name) !== str(b.name)) ops.push({ op: 'set_name', loc: a, text: str(o.name) });
    if (str(o.description) && str(o.description) !== str(b.description)) ops.push({ op: 'set_description', loc: a, text: str(o.description) });
    if (!same(b.expandable, o.expandable)) ops.push({ op: 'set_expandable', target: a, value: o.expandable ?? null });
    const f = fieldDiff(b, o, FIELD_KEYS.room);
    if (Object.keys(f).length) ops.push({ op: 'set_fields', target: a, fields: f });
    const orig = new Map((ctx.exits ?? []).map(e => [e.direction, e]));
    for (const e of state.exits ?? []) {
        if (e.orig === null) continue;
        const was = orig.get(e.orig);
        if (!was) continue;
        if (e.removed) { ops.push({ op: 'remove_exit', loc: a, direction: e.orig }); continue; }
        const d = str(e.side.description);
        if (d && d !== str(was.side?.description)) ops.push({ op: 'set_exit_description', loc: a, direction: e.orig, text: d });
        if (str(e.travel_time) && str(e.travel_time) !== str(was.travel_time)) ops.push({ op: 'set_travel_time', loc: a, direction: e.orig, time: str(e.travel_time) });
        const sideKeys = EXIT_SIDE_KEYS.filter(k => k !== 'description' && k !== 'direction');
        const fields = fieldDiff(was.side ?? {}, e.side, sideKeys);
        if (!same(was.barrier, e.barrier)) fields.barrier = e.barrier;
        if (str(e.side.direction) && str(e.side.direction) !== e.orig) fields.direction = str(e.side.direction); // last: later ops use the old name
        if (Object.keys(fields).length) ops.push({ op: 'set_exit', loc: a, direction: e.orig, fields });
    }
    for (const e of state.exits ?? []) {
        if (e.orig !== null || e.removed || !str(e.side.direction) || !str(e.to)) continue;
        const op = { op: 'add_exit', loc: a, direction: str(e.side.direction), to: e.to, return_direction: str(e.return_direction) || 'back' };
        if (str(e.travel_time)) op.travel_time = str(e.travel_time);
        if (str(e.side.description)) op.description = str(e.side.description);
        if (str(e.return_description)) op.return_description = str(e.return_description);
        if (e.barrier) op.door = true;
        ops.push(op);
    }
    if (state.area && state.area !== ctx.area) ops.push({ op: 'move_location', loc: a, area: state.area });
    return ops;
}
/** The patch ops for a subregion or region form. */
export function areaOps(ctx, state) {
    const area = ctx.area, b = ctx.own ?? {}, o = state.own ?? {}, ops = [];
    const name = str(o.name) !== str(b.name) && str(o.name), notes = str(o.notes) !== str(b.notes) && str(o.notes);
    if (name || notes) ops.push({ op: 'update_area', area, ...(name ? { name } : {}), ...(notes ? { notes } : {}) });
    if (!same(b.expandable, o.expandable)) ops.push({ op: 'set_expandable', target: area, value: o.expandable ?? null });
    const f = fieldDiff(b, o, FIELD_KEYS[ctx.kind]);
    if (Object.keys(f).length) ops.push({ op: 'set_fields', target: area, fields: f });
    return ops;
}
/** Problems the user should fix before Submit (empty required fields, a new exit with no destination). */
export function formProblems(ctx, state) {
    const out = [];
    const specs = ctx.kind === 'room' ? ROOM_FIELDS : AREA_FIELDS[ctx.kind];
    for (const s of specs) if (s.required && has(ctx.own, s.k) && !str(state.own[s.k])) out.push(`${s.label} can't be empty`);
    for (const e of state.exits ?? []) {
        if (e.removed) continue;
        if (!str(e.side.direction)) out.push('Every exit needs a direction');
        if (e.orig === null && !str(e.to)) out.push(`The new exit ${str(e.side.direction) || ''} needs a destination`.replace('  ', ' '));
    }
    const dirs = (state.exits ?? []).filter(e => !e.removed).map(e => str(e.side.direction).toLowerCase()).filter(Boolean);
    if (new Set(dirs).size < dirs.length) out.push('Two exits have the same direction');
    return out;
}

// ---- DOM

const showVal = v => (v === null || v === undefined ? '(none)' : typeof v === 'boolean' ? (v ? 'yes' : 'no') : String(v));
/**
 * One field row bound to obj[spec.k]. `inh` is {value, from} when an unset field inherits something; `dflt` the
 * value an unset field defaults to. An unset field shows that value greyed out with a "from …" tag; once set, a small
 * reset button drops it again (back to inheriting).
 */
export function fieldRow(doc, spec, obj, { inh = null, options = null, onChange = () => {}, ai = null } = {}) {
    const el = (tag, attrs = {}, ...kids) => { const n = doc.createElement(tag); for (const [k, v] of Object.entries(attrs)) { if (k.startsWith('on')) n.addEventListener(k.slice(2), v); else if (v !== undefined && v !== null && v !== false) n.setAttribute(k, v === true ? '' : v); } n.append(...kids.filter(x => x !== null && x !== undefined)); return n; };
    const row = el('div', { class: 'pf-row', 'data-field': spec.k });
    const getInh = typeof inh === 'function' ? inh : () => inh;
    const opts = (options ?? spec.options ?? []).map(x => (isObj(x) ? x : { value: x, label: x }));
    const render = () => {
        const fallback = getInh() ?? (spec.dflt !== undefined ? { value: spec.dflt, from: 'default' } : null);
        const set = has(obj, spec.k) && obj[spec.k] !== undefined, cur = set ? obj[spec.k] : fallback?.value;
        row.classList.toggle('inherited', !set && !!fallback);
        const change = v => { if (v === undefined) delete obj[spec.k]; else obj[spec.k] = v; onChange(); render(); };
        let ctl;
        if (spec.type === 'bool') {
            ctl = el('input', { type: 'checkbox', class: 'pf-input' });
            ctl.checked = !!cur;
            ctl.addEventListener('change', () => change(ctl.checked));
        } else if (spec.type === 'choice' && opts.length <= 3) {
            const name = `pf_${spec.k}_${Math.random().toString(36).slice(2, 8)}`;
            ctl = el('span', { class: 'pf-radios' }, ...opts.map(o => {
                const r = el('input', { type: 'radio', name, value: o.value, class: 'pf-input' });
                r.checked = cur === o.value;
                r.addEventListener('change', () => change(o.value));
                return el('label', { class: 'pf-radio' }, r, ` ${o.label}`);
            }));
        } else if (spec.type === 'choice') {
            ctl = el('select', { class: 'pf-input' }, el('option', { value: '' }, fallback ? `(${showVal(fallback.value)})` : '(not set)'), ...opts.map(o => el('option', { value: o.value }, o.label)));
            ctl.value = set ? String(cur) : '';
            ctl.addEventListener('change', () => change(ctl.value === '' ? undefined : ctl.value));
        } else {
            ctl = el(spec.type === 'textarea' ? 'textarea' : 'input', { class: 'pf-input', ...(spec.type === 'textarea' ? { rows: 3 } : { type: spec.type === 'number' ? 'number' : 'text' }) });
            ctl.value = set ? String(cur) : '';
            if (fallback && !set) ctl.placeholder = showVal(fallback.value);
            // Typing never re-renders (it would lose the caret); clearing an inheritable field goes back to inheriting.
            ctl.addEventListener('input', () => {
                const v = ctl.value;
                if (v === '' && !spec.required) delete obj[spec.k]; else obj[spec.k] = spec.type === 'number' ? Number(v) : v;
                row.classList.toggle('inherited', !has(obj, spec.k) && !!fallback);
                reset.hidden = !(has(obj, spec.k) && fallback);
                onChange();
            });
        }
        const tag = !set && fallback ? el('span', { class: 'pf-from' }, fallback.tag ?? (fallback.from === 'default' ? 'default' : `from ${fallback.from}`)) : set && inh ? el('span', { class: 'pf-from pf-own' }, 'set here') : null;
        const reset = el('button', { type: 'button', class: 'pf-reset', title: fallback ? `${fallback.from === 'default' ? 'Reset to default' : `Reset to inherited (from ${fallback.from}`}: ${showVal(fallback.value)}${fallback.from === 'default' ? '' : ')'}` : 'Reset', 'aria-label': fallback?.from === 'default' ? 'Reset to default' : 'Reset to inherited', onclick: () => change(undefined) }, '↺');
        reset.hidden = !(set && fallback && !spec.required);
        const aiBtn = ai && spec.ai ? el('button', { type: 'button', class: 'pf-ai', title: 'Expand with AI: a richer present-tense text from what is here (you can still edit it)', onclick: async () => {
            aiBtn.disabled = true; const was = aiBtn.textContent; aiBtn.textContent = '…';
            try { const t = await ai(spec.k, String(ctl.value ?? '')); if (t) { ctl.value = t; ctl.dispatchEvent(new Event('input')); } } catch (e) { aiBtn.title = `Expand failed: ${e.message}`; } finally { aiBtn.disabled = false; aiBtn.textContent = was; }
        } }, '✨ Expand with AI') : null;
        row.replaceChildren(...[el('label', { class: 'pf-label' }, typeof spec.label === 'function' ? spec.label() : spec.label), ctl, tag, reset, aiBtn].filter(x => x !== null && x !== undefined));
    };
    render();
    row.rerender = render;
    return row;
}

/**
 * The whole form. ctx: /edit/context; onSubmit(ops) runs on Submit (the caller previews and stamps them).
 * Returns {el, state, getOps(), problems()}.
 */
export function buildEditForm(doc, ctx, { onChange = () => {}, ai = null, expand = null } = {}) {
    const el = (tag, attrs = {}, ...kids) => { const n = doc.createElement(tag); for (const [k, v] of Object.entries(attrs)) { if (k.startsWith('on')) n.addEventListener(k.slice(2), v); else if (v !== undefined && v !== null && v !== false) n.setAttribute(k, v === true ? '' : v); } n.append(...kids.filter(x => x !== null && x !== undefined)); return n; };
    const state = initialState(ctx), changed = () => onChange(getOps());
    const getOps = () => (ctx.kind === 'room' ? placeOps(ctx, state) : areaOps(ctx, state));
    const root = el('div', { class: 'placeform', 'data-kind': ctx.kind });
    const specs = ctx.kind === 'room' ? ROOM_FIELDS : AREA_FIELDS[ctx.kind];
    const aiFor = fieldObj => (ai ? (k, text) => ai({ kind: ctx.kind, field: k, text, exit: fieldObj }) : null);
    const textKey = ctx.kind === 'room' ? 'description' : 'notes';
    for (const s of specs) {
        // Descriptions and notes are additive: the own text is never inherited, so no placeholder or reset.
        const inh = s.k === textKey ? null : ctx.inherited?.[s.k] ?? null;
        root.append(fieldRow(doc, s, state.own, { inh, options: s.options === 'entrances' ? ctx.entrances : null, onChange: changed, ai: aiFor(null) }));
        if (s.k === textKey && ctx.parent_notes?.length) {
            const box = el('div', { class: 'pf-parent-notes', 'data-field': 'parent_notes' });
            for (const n of ctx.parent_notes) box.append(el('div', { class: 'pf-parent-note muted', 'data-from': n.from, 'data-toggle': n.toggle },
                el('span', { class: 'pf-from' }, `added from ${n.from} (${n.name})`), ' ', el('span', { class: 'pf-note-text' }, n.text)));
            root.append(box);
        }
    }
    // Greys out a parent note while its inherit toggle is off.
    const syncNotes = () => { for (const d of root.querySelectorAll('.pf-parent-note')) { const k = d.dataset.toggle, v = has(state.own, k) ? state.own[k] : ctx.inherited?.[k]?.value ?? true; d.classList.toggle('off', v === false); } };
    root.addEventListener('change', syncNotes); root.addEventListener('click', () => setTimeout(syncNotes)); syncNotes();
    if (ctx.kind === 'room') {
        const mv = el('select', { class: 'pf-input pf-move' }, ...(ctx.subregions ?? []).map(s => el('option', { value: s.area }, s.name)));
        mv.value = state.area;
        mv.addEventListener('change', () => { state.area = mv.value; changed(); });
        root.append(el('div', { class: 'pf-row', 'data-field': 'move' }, el('label', { class: 'pf-label' }, 'Move to subregion'), mv));
        const list = el('div', { class: 'pf-exits' });
        const blocks = [];
        const addBlock = (e, open) => {
            const blk = el('div', { class: 'pf-exit' });
            const body = el('div', { class: 'pf-exit-body' });
            const head = el('div', { class: 'pf-exit-head' });
            const title = () => `${str(e.side.direction) || '(new exit)'} → ${e.to_name ?? ctx.rooms?.find(r => r.address === e.to)?.name ?? (e.to || '?')}${e.removed ? ' (removed)' : ''}`;
            const setOpen = v => { body.hidden = !v || e.removed; tog.textContent = v ? '▾' : '▸'; blk.classList.toggle('collapsed', !v); };
            const tog = el('button', { type: 'button', class: 'pf-toggle', onclick: () => setOpen(body.hidden) }, '▾');
            const name = el('span', { class: 'pf-exit-title', onclick: () => setOpen(body.hidden) }, title());
            const x = el('button', { type: 'button', class: 'pf-x', title: 'Remove this exit (and the way back)', onclick: () => {
                if (e.orig === null) { blk.remove(); blocks.splice(blocks.indexOf(ctl), 1); state.exits.splice(state.exits.indexOf(e), 1); changed(); return; }
                e.removed = !e.removed; blk.classList.toggle('removed', e.removed); x.textContent = e.removed ? 'Undo' : '✕'; name.textContent = title(); setOpen(!e.removed); changed();
            } }, '✕');
            head.append(tog, name, x);
            const upd = () => { name.textContent = title(); changed(); };
            if (e.orig === null) {
                const to = el('select', { class: 'pf-input pf-to' }, el('option', { value: '' }, '(pick a place)'), ...(ctx.rooms ?? []).map(r => el('option', { value: r.address }, `${r.name} (${r.area_name})`)));
                to.addEventListener('change', () => { e.to = to.value; e.to_name = null; upd(); });
                body.append(el('div', { class: 'pf-row', 'data-field': 'to' }, el('label', { class: 'pf-label' }, 'Leads to'), to));
            } else body.append(el('div', { class: 'pf-row muted', 'data-field': 'to' }, el('label', { class: 'pf-label' }, 'Leads to'), e.to_name ?? e.to));
            const live = [];
            const senseHead = el('b', { class: 'pf-sense-head', 'data-for': 'exit' });
            const headText = () => { senseHead.textContent = e.barrier ? 'Sense transparency – unblocked' : 'Sense transparency'; };
            const upd2 = () => { for (const x of live) x.rerender(); headText(); upd(); };
            headText();
            for (const s of EXIT_FIELDS) {
                if (s.k === 'sight') body.append(senseHead);
                const holder = s.shared ? e : e.side;
                const lv = s.k === 'sight' || s.k === 'sound' ? () => exitLevelDefault(e, s.k) : null;
                const sp = s;
                const fr = fieldRow(doc, s.shared ? { ...s, k: 'travel_time' } : sp, holder, { onChange: upd2, ai: aiFor(e), ...(lv ? { inh: lv } : {}) });
                if (lv) live.push(fr);
                body.append(fr);
            }
            if (e.orig === null) {
                const rd = { return_direction: e.return_direction, return_description: e.return_description };
                body.append(fieldRow(doc, { k: 'return_direction', type: 'text', label: 'Way back (direction)' }, rd, { onChange: () => { e.return_direction = rd.return_direction ?? ''; upd(); } }),
                    fieldRow(doc, { k: 'return_description', type: 'textarea', label: 'Way back description' }, rd, { onChange: () => { e.return_description = rd.return_description ?? ''; upd(); } }));
            }
            const doorBox = el('div', { class: 'pf-door' });
            const doorRows = () => doorBox.replaceChildren(...(e.barrier ? DOOR_FIELDS.flatMap(s => [...(s.k === 'closed_sight' ? [el('b', { class: 'pf-sense-head', 'data-for': 'door' }, 'Sense transparency – blocked')] : []), fieldRow(doc, s, e.barrier, { onChange: upd2 })]) : []));
            const dk = el('input', { type: 'checkbox', class: 'pf-input' }); dk.checked = !!e.barrier;
            dk.addEventListener('change', () => { e.barrier = dk.checked ? {} : null; doorRows(); upd2(); });
            body.append(el('div', { class: 'pf-row', 'data-field': 'door' }, el('label', { class: 'pf-label' }, 'Door (shared by both sides)'), dk), doorBox);
            doorRows();
            blk.append(head, body);
            const ctl = { setOpen };
            blocks.push(ctl);
            setOpen(open);
            return blk;
        };
        const addBtn = el('button', { type: 'button', class: 'crumb pf-addexit', onclick: () => { const e = newExit(); state.exits.push(e); list.prepend(addBlock(e, true)); changed(); } }, '+ Add exit');
        const all = v => blocks.forEach(b => b.setOpen(v));
        root.append(el('div', { class: 'pf-exits-head' }, el('b', {}, 'Exits'), ' ', addBtn, ' ',
            el('button', { type: 'button', class: 'crumb pf-collapse', onclick: () => all(false) }, 'Collapse all'), ' ',
            el('button', { type: 'button', class: 'crumb pf-expand', onclick: () => all(true) }, 'Expand all')), list);
        for (const e of state.exits) list.append(addBlock(e, expand ? e.orig?.toLowerCase() === expand : false));
    }
    return { el: root, state, getOps, problems: () => formProblems(ctx, state) };
}

/**
 * The prompt for "Expand with AI" on a description or notes field. ctx is /edit/ai-context's answer: only the parent
 * region / subregion notes and the names and first sentences of the places the exits lead to, never the whole world.
 */
export function expandPrompt(ctx, { field = 'description', text = '', name = '', kind = 'room' } = {}) {
    const what = kind === 'room' ? 'place' : kind, L = [];
    if (ctx?.region) L.push(`Region: ${ctx.region.name}${ctx.region.notes ? ` - ${ctx.region.notes}` : ''}`);
    if (ctx?.subregion && kind === 'room') L.push(`Area: ${ctx.subregion.name}${ctx.subregion.notes ? ` - ${ctx.subregion.notes}` : ''}`);
    if (ctx?.neighbors?.length) L.push('Connected places:', ...ctx.neighbors.map(n => `- ${n.name}${n.short ? `: ${n.short}` : ''}`));
    L.push('', `Write the ${field === 'notes' ? 'notes (facts for the narrator: who is here, what goes on, secrets)' : 'description (what a visitor sees, hears and smells)'} for the ${what} "${name || 'new ' + what}".`);
    if (String(text).trim()) L.push(`Expand on this draft, keeping everything in it: ${String(text).trim()}`);
    L.push('Two to four sentences of plain prose, fitting the setting above. Reply with only the text.');
    return L.join('\n');
}
