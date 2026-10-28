// One shared editor for map patches (see patches.mjs), used by the Keep / Discard card in SillyTavern and by the
// map window's "Edit live" button. The pure helpers (cleanOp, formOps, checkOps, errorsByOp, blankOp, liveOps) run in
// node too; buildPatchForm needs a DOM `document`. The form never changes the map itself: the caller previews the
// ops on the server and stamps them on a chat message.
import { OPS, parseLasts, newRoomId } from './patches.mjs';

export const EXIT_OPS = ['block_exit', 'open_exit', 'lock_exit', 'unlock_exit', 'break_exit', 'remove_exit'];
export const OP_LABELS = {
    set_description: 'Rewrite description', append_description: 'Add to description', set_name: 'Rename place',
    set_notes: 'Rewrite area notes', update_area: 'Rename area / rewrite its notes', append_notes: 'Add to area notes',
    block_exit: 'Exit: block', open_exit: 'Exit: open', lock_exit: 'Exit: lock', unlock_exit: 'Exit: unlock', break_exit: 'Exit: break open', remove_exit: 'Exit: remove', set_exit_description: 'Exit: rewrite its description (this side)', set_travel_time: 'Exit: travel time (both ways)',
    remove_location: 'Remove place', merge: 'Merge places', discover: 'New room behind a door', set_expandable: 'Allow / forbid discovered rooms',
    set_fields: 'Change settings', set_exit: 'Exit: change settings', add_exit: 'Exit: add (with the way back)', move_location: 'Move place to another subregion', move_area: 'Move subregion to another region',
    create_place: 'Create place', create_subregion: 'Create subregion', create_region: 'Create region', remove_area: 'Delete subregion / region',
};
/** Fields holding objects or lists (typed as JSON in the review card). */
const JSON_KEYS = new Set(['fields', 'exits', 'place', 'subregion', 'ids']);
/** The fields each op type has (besides "op" and "lasts"), and which are required. */
export const OP_FIELDS = {
    set_description: [['loc', 1], ['text', 1]], append_description: [['loc', 1], ['text', 1]], set_name: [['loc', 1], ['text', 1]],
    update_area: [['area', 1], ['name', 0], ['notes', 0]],
    set_notes: [['area', 1], ['text', 1]], append_notes: [['area', 1], ['text', 1]],
    ...Object.fromEntries(EXIT_OPS.map(o => [o, [['loc', 1], ['direction', 1]]])),
    set_exit_description: [['loc', 1], ['direction', 1], ['text', 1]],
    set_travel_time: [['loc', 1], ['direction', 1], ['time', 1]],
    remove_location: [['loc', 1]],
    merge: [['locs', 1], ['into', 0], ['name', 0], ['description', 0], ['area', 0]],
    discover: [['loc', 1], ['direction', 1], ['name', 1], ['description', 1], ['return_direction', 0], ['exit_description', 0], ['return_description', 0], ['id', 0]],
    set_expandable: [['target', 1], ['value', 1]],
    set_fields: [['target', 1], ['fields', 1]],
    set_exit: [['loc', 1], ['direction', 1], ['fields', 1]],
    add_exit: [['loc', 1], ['direction', 1], ['to', 1], ['return_direction', 0], ['travel_time', 0], ['description', 0], ['return_description', 0], ['door', 0]],
    move_location: [['loc', 1], ['area', 1], ['id', 0]],
    move_area: [['area', 1], ['region', 1], ['id', 0]],
    create_place: [['area', 1], ['name', 1], ['description', 1], ['exits', 1], ['id', 0]],
    create_subregion: [['region', 1], ['name', 1], ['place', 1], ['notes', 0], ['id', 0]],
    create_region: [['name', 1], ['subregion', 1], ['notes', 0], ['id', 0]],
    remove_area: [['area', 1], ['contents', 1], ['into', 0], ['ids', 0]],
};
const s = v => (typeof v === 'string' ? v.trim() : v === null || v === undefined ? '' : String(v).trim());

/** An op reduced to the fields its type uses, strings trimmed, empty optional fields left out. */
export function cleanOp(op) {
    const type = s(op?.op), out = { op: type };
    for (const [k] of OP_FIELDS[type] ?? []) {
        if (k === 'locs') { out.locs = [...new Set((Array.isArray(op.locs) ? op.locs : s(op.locs).split(',')).map(s).filter(Boolean))]; continue; }
        if (JSON_KEYS.has(k)) { // objects / lists (the Edit forms and wizards); typed as JSON in the review card
            let f = op?.[k];
            if (typeof f === 'string') { if (!f.trim()) continue; try { f = JSON.parse(f); } catch { /* reported by the server */ } }
            if (f !== undefined && f !== null && f !== '') out[k] = f;
            continue;
        }
        if (k === 'door' && typeof op?.door === 'boolean') { out.door = op.door; continue; }
        const v = s(op?.[k]);
        if (v) out[k] = k === 'door' ? v === 'true' : v;
    }
    const lasts = s(op?.lasts);
    if (lasts) out.lasts = lasts;
    return out;
}
/** The ops of a form (a list of op drafts) as a patch's ops list. */
export const formOps = drafts => (drafts ?? []).map(cleanOp);

/** Quick checks before asking the server (which checks everything against the map): [{i, error}]. */
export function checkOps(ops) {
    const errs = [];
    if (!ops?.length) errs.push({ i: null, error: 'Add at least one change.' });
    (ops ?? []).forEach((op, i) => {
        if (!OPS.includes(op.op)) { errs.push({ i, error: `Unknown change type ${JSON.stringify(op.op)}.` }); return; }
        for (const [k, req] of OP_FIELDS[op.op]) {
            if (!req) continue;
            if (k === 'locs' ? !(op.locs?.length) : !s(op[k])) errs.push({ i, error: `"${k}" is required.` });
        }
        if (op.op === 'update_area' && !s(op.name) && !s(op.notes)) errs.push({ i, error: 'Give the area a new name and/or notes.' });
        if (op.op === 'merge') {
            if (op.into && !op.locs?.includes(op.into)) errs.push({ i, error: '"Keep as" must be one of the merged places.' });
            if (!op.into && (!s(op.name) || !s(op.description))) errs.push({ i, error: 'A merge into a new place needs a name and a description (or pick one place to keep).' });
        }
        if (op.lasts) { try { parseLasts(op.lasts); } catch (e) { errs.push({ i, error: e.message }); } }
    });
    return errs;
}
/** A server error ("patch, op #2: ...") split to the op it is about: {i (0-based) | null, error}. */
export function errorsByOp(message) {
    const m = /op #(\d+):\s*(.*)$/s.exec(String(message ?? ''));
    return m ? { i: Number(m[1]) - 1, error: m[2] } : { i: null, error: String(message ?? '') };
}
/** A new op of `type`, with `loc` / `area` filled in from the context. */
export function blankOp(type, { loc = '', area = '', direction = '', text = '' } = {}) {
    const op = { op: type };
    for (const [k] of OP_FIELDS[type] ?? []) op[k] = k === 'locs' ? (loc ? [loc] : []) : k === 'loc' ? loc : k === 'area' && type !== 'merge' ? area : k === 'direction' ? direction : k === 'text' ? text : '';
    return op;
}
/** Starting ops for "Edit live" on an inspector target, prefilled from its live values. */
export function liveOps(target, { description = '', notes = '', name = '' } = {}) {
    const t = String(target ?? '');
    if (t.startsWith('exit:')) { const ref = t.slice(5), i = ref.lastIndexOf('|'); return [blankOp('block_exit', { loc: ref.slice(0, i), direction: ref.slice(i + 1) })]; }
    // Regions and subregions: rename and/or rewrite the notes (update_area); set_notes / append_notes can be added in the form.
    if (t.startsWith('region:') || t.startsWith('sub:')) return [{ ...blankOp('update_area', { area: t.slice(t.startsWith('sub:') ? 4 : 7) }), name: name ?? '', notes: notes ?? '' }];
    if (t.includes('/')) return [blankOp('set_description', { loc: t, text: description ?? '' })];
    return [];
}
/** "Map edit: Drowned Rat description changed" (the visible line of a map-window edit). */
export function editLine(summary = [], fallback = 'map changed') {
    const t = (summary ?? []).join('; ') || fallback;
    return `Map edit: ${t.length > 200 ? `${t.slice(0, 199)}…` : t}`;
}

/** The visible line of a map-edit carrier message: one edit reads as its summary, several as "Map update (N changes)". */
export function carrierText(patches = []) {
    const list = (patches ?? []).filter(Boolean);
    return list.length === 1 ? editLine(list[0].summary, list[0].note || 'map changed') : `Map update (${list.length} changes)`;
}

/**
 * The editor. opts: {ops, rooms: [address], areas: [area id], exits: {address: [direction]}, context: {loc, area}}.
 * Returns {el, getOps(), setErrors([{i, error}]), setOps(ops)}. Inline styles only, so it fits SillyTavern and the map window.
 */
export function buildPatchForm(doc, opts = {}) {
    const st = (el, css) => { el.style.cssText = css; return el; };
    const mk = (tag, attrs = {}, ...kids) => { const el = doc.createElement(tag); for (const [k, v] of Object.entries(attrs)) { if (k === 'class') el.className = v; else if (k === 'text') el.textContent = v; else if (k.startsWith('on')) el.addEventListener(k.slice(2), v); else el.setAttribute(k, v); } el.append(...kids); return el; };
    const uid = `wspf${Math.random().toString(36).slice(2, 8)}`;
    let drafts = (opts.ops ?? []).map(o => ({ ...structuredClone(o), locs: Array.isArray(o.locs) ? [...o.locs] : o.locs }));
    let errors = [];
    const root = st(mk('div', { class: 'wspf' }), 'display:flex;flex-direction:column;gap:6px;margin:4px 0;');
    const lists = mk('div');
    const dl = (id, vals) => { const d = mk('datalist', { id }); for (const v of vals ?? []) d.append(mk('option', { value: v })); return d; };
    lists.append(dl(`${uid}-rooms`, opts.rooms), dl(`${uid}-areas`, opts.areas));
    const stop = el => { for (const ev of ['click', 'keydown', 'keyup', 'input', 'mousedown']) el.addEventListener(ev, e => e.stopPropagation()); return el; };
    const input = (val, on, attrs = {}) => stop(st(mk('input', { type: 'text', value: val ?? '', class: 'text_pole wspf-in', ...attrs, oninput: e => on(e.target.value) }), 'width:100%;box-sizing:border-box;margin:0;border:1px solid var(--SmartThemeBorderColor, #888);background-color:var(--black30a, rgba(0,0,0,0.3));color:var(--SmartThemeBodyColor, inherit);border-radius:4px;padding:3px 5px;'));
    const area = (val, on) => { const t = stop(st(mk('textarea', { class: 'text_pole wspf-text', rows: '4', oninput: e => on(e.target.value) }), 'width:100%;box-sizing:border-box;min-height:5em;resize:vertical;margin:0;border:1px solid var(--SmartThemeBorderColor, #888);background-color:var(--black30a, rgba(0,0,0,0.3));color:var(--SmartThemeBodyColor, inherit);border-radius:4px;padding:3px 5px;')); t.value = val ?? ''; return t; };
    const field = (label, ctl) => st(mk('label', {}, st(mk('span', { text: label }), 'display:block;font-size:0.85em;opacity:0.8;'), ctl), 'display:block;');
    const btn = (label, on, title = '') => stop(st(mk('button', { type: 'button', class: 'menu_button wspf-btn', title, onclick: e => { e.preventDefault(); on(); } }, label), 'display:inline-block;width:auto;padding:2px 8px;margin:0 4px 0 0;font-size:0.9em;cursor:pointer;'));
    const select = (val, choices, on) => { const el = stop(st(mk('select', { class: 'text_pole wspf-sel', onchange: e => on(e.target.value) }), 'width:auto;margin:0;border:1px solid var(--SmartThemeBorderColor, #888);background-color:var(--black30a, rgba(0,0,0,0.3));color:var(--SmartThemeBodyColor, inherit);border-radius:4px;padding:3px 5px;')); for (const [v, l] of choices) { const o = mk('option', { value: v, text: l }); if (v === val) o.selected = true; el.append(o); } return el; };
    // Places and areas are always picked from the map, never typed: labels are friendly names ("Common Room (Drowned Rat)").
    const pretty = id => String(id).replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    const roomLabel = a => opts.names?.[a] ?? (a.includes('/') ? `${pretty(a.split('/').pop())} (${pretty(a.split('/')[0].split(':').pop())})` : a);
    const areaLabel = a => opts.areaNames?.[a] ?? (a.includes(':') ? `${pretty(a.split(':')[1])} (in ${pretty(a.split(':')[0])})` : `${pretty(a)} (region)`);
    const picker = (val, list, label, on, blank) => {
        const vals = [...new Set([...(list ?? [])])].sort((x, y) => label(x).localeCompare(label(y)));
        const tail = String(val ?? '').trim().toLowerCase().split(/[:/]/).pop().replace(/[^a-z0-9]+/g, '_');
        const amb = val && !vals.includes(val) ? vals.filter(v => v.includes('/') && v.toLowerCase().endsWith(`/${tail}`)) : [];
        if (amb.length > 1) { // ambiguous reference: ask which one instead of guessing
            const el = select('', [['', `"${val}" could be several places — which one?`], ...amb.map(v => [v, label(v)]), ...vals.filter(v => !amb.includes(v)).map(v => [v, label(v)])], on);
            el.style.width = '100%'; el.classList.add('wspf-pick', 'wspf-ambig'); return el;
        }
        if (val && !vals.includes(val)) vals.unshift(val); // keep an unknown value visible so the error next to it makes sense
        const el = select(val ?? '', [['', blank], ...vals.map(v => [v, label(v)])], on);
        el.style.width = '100%'; el.classList.add('wspf-pick'); return el;
    };
    const roomPick = (val, on, blank = '— pick a place —') => picker(val, opts.rooms, roomLabel, on, blank);
    const areaPick = (val, on, blank = '— pick an area —') => picker(val, opts.areas, areaLabel, on, blank);
    let noops = [];
    const rowsBox = mk('div');
    const top = st(mk('div', { class: 'wspf-error' }), 'color:#e66;');
    let drawn = false;
    const changed = () => { if (drawn) opts.onChange?.(formOps(drafts)); };
    function render(quiet = false) {
        rowsBox.replaceChildren();
        if (!quiet) queueMicrotask(changed);
        drawn = true;
        top.textContent = errors.filter(e => e.i === null || e.i >= drafts.length).map(e => e.error).join(' ');
        drafts.forEach((d, i) => {
            const box = st(mk('div', { class: 'wspf-op', 'data-op': d.op }), 'border:1px solid var(--SmartThemeBorderColor, #666);border-radius:6px;padding:6px;display:flex;flex-direction:column;gap:4px;');
            const head = st(mk('div'), 'display:flex;gap:6px;align-items:center;flex-wrap:wrap;');
            head.append(select(d.op, OPS.map(o => [o, OP_LABELS[o] ?? o]), v => { drafts[i] = { ...blankOp(v, { loc: d.loc ?? d.locs?.[0] ?? '', area: d.area ?? '', direction: d.direction ?? '' }), text: d.text ?? '', lasts: d.lasts ?? '' }; render(); }),
                btn('Remove', () => { drafts.splice(i, 1); errors = []; render(); }, 'Drop this change'));
            box.append(head);
            const set = k => v => { d[k] = v; };
            for (const [k, req] of OP_FIELDS[d.op] ?? []) {
                const lab = `${{ loc: 'Place', area: 'Area (region or region:subregion)', text: d.op === 'set_name' ? 'New name' : d.op.includes('notes') ? 'Notes' : 'Description', direction: 'Exit', locs: 'Places to merge', into: 'Keep as', id: 'New place id', name: d.op === 'update_area' ? 'New display name (the id stays the same)' : 'New name', description: 'New description', area_m: 'Area', return_direction: 'Exit name back (default: out)', exit_description: 'Door description (this side)', return_description: 'Door description (the new room side)', target: 'Room, area (region:subregion) or region', value: 'true, false or inherit' }[k] ?? k}${req ? '' : ' (optional)'}`;
                if (k === 'text') box.append(field(lab, d.op === 'set_name' ? input(d.text, set('text')) : area(d.text, set('text'))));
                else if (k === 'notes') box.append(field('New notes (optional)', area(d.notes, set('notes'))));
                else if (k === 'description') box.append(field(lab, area(d.description, set('description'))));
                else if (k === 'loc') box.append(field(lab, roomPick(d.loc, v => { d.loc = v; render(); })));
                else if (k === 'area') box.append(field(d.op === 'merge' ? 'Area for the merged place (optional)' : lab.replace(' (region or region:subregion)', ''), areaPick(d.area, set('area'), d.op === 'merge' ? '— same as the kept place —' : undefined)));
                else if (k === 'direction') {
                    const known = opts.exits?.[s(d.loc)] ?? [];
                    box.append(field(lab, input(d.direction, set('direction'), { list: `${uid}-ex-${i}` })), dl(`${uid}-ex-${i}`, known));
                } else if (k === 'locs') {
                    const ul = st(mk('ul', { class: 'wspf-locs' }), 'margin:0;padding-left:1.2em;');
                    (d.locs ??= []).forEach((a, j) => ul.append(mk('li', { title: a }, `${roomLabel(a)} `, btn('×', () => { d.locs.splice(j, 1); if (d.into === a) d.into = ''; render(); }, 'Take this place out of the merge'))));
                    const addIn = picker('', (opts.rooms ?? []).filter(a => !d.locs.includes(a)), roomLabel, v => { if (v && !d.locs.includes(v)) d.locs.push(v); render(); }, '+ add a place to merge…');
                    box.append(field(lab, ul), addIn);
                } else if (k === 'into') box.append(field(lab, select(d.into ?? '', [['', 'a new place (give name, description)'], ...(d.locs ?? []).map(a => [a, roomLabel(a)])], v => { d.into = v; render(); })));
                else if (k === 'name' && d.op === 'merge') {
                    const idNote = st(mk('span', { class: 'wspf-newid' }), 'font-size:0.8em;opacity:0.7;');
                    const show = v => { idNote.textContent = d.into || !s(v) ? '' : `new place id: ${newRoomId(v)} (from the name; _2 is added if taken)`; };
                    box.append(field(lab, input(d.name, v => { d.name = v; show(v); })), idNote); show(d.name);
                } else if (JSON_KEYS.has(k)) box.append(field(lab, area(typeof d[k] === 'string' ? d[k] : d[k] == null ? '' : JSON.stringify(d[k]), set(k))));
                else box.append(field(lab, input(typeof d[k] === 'boolean' ? String(d[k]) : d[k], set(k))));
            }
            box.append(field('Lasts (optional, e.g. 3d, 12h; empty = permanent)', input(d.lasts, set('lasts'), { placeholder: 'permanent' })));
            const nop = noops.find(n => n.i === i);
            if (nop) { box.style.opacity = '0.55'; box.classList.add('wspf-noop'); head.append(st(mk('span', { class: 'wspf-nochange', text: 'no change', title: nop.why }), 'font-size:0.8em;font-style:italic;padding:0 6px;border:1px solid var(--SmartThemeBorderColor);border-radius:8px;')); }
            const errs = errors.filter(e => e.i === i);
            if (errs.length) box.append(st(mk('div', { class: 'wspf-error', text: errs.map(e => e.error).join(' ') }), 'color:#e66;'));
            rowsBox.append(box);
        });
    }
    let addType = 'set_description';
    const adder = st(mk('div', { class: 'wspf-add' }), 'display:flex;gap:4px;align-items:center;flex-wrap:wrap;');
    adder.append(select(addType, OPS.map(o => [o, OP_LABELS[o] ?? o]), v => { addType = v; }), btn('Add change', () => { drafts.push(blankOp(addType, opts.context ?? {})); render(); }));
    root.append(lists, top, rowsBox, adder);
    render();
    for (const ev of ['input', 'change']) root.addEventListener(ev, () => setTimeout(changed), true); // capture (the fields stop bubbling); deferred so the field's own handler has updated the draft first
    stop(root);
    return {
        el: root,
        getOps: () => formOps(drafts),
        setErrors: list => { errors = list ?? []; render(); },
        /** Grey out ops that change nothing ([{i, why}] from the preview), without re-firing onChange. */
        setNoops: list => { const n = JSON.stringify(list ?? []); if (n === JSON.stringify(noops)) return; noops = list ?? []; render(true); },
        setOps: ops => { drafts = structuredClone(ops ?? []); errors = []; render(); },
    };
}
