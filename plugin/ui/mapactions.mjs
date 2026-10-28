// The map's create / move / delete wizards (inspector buttons beside Edit). Pure DOM; everything that talks to the
// server or the SillyTavern tab comes in through `io`:
//   io = { outline(): {regions, start_region}, preview(ops) -> diff (throws Error with .detail {error, clash?}),
//          submit(ops) -> {ok, msg, summary, errors}, aiText({field, kind, name, area, rooms, text}) -> string,
//          renderDiff(doc, pv), back() }
// Every wizard builds patch ops (create_region / create_subregion / create_place / merge / remove_location /
// remove_area / move_location / move_area); the engine checks them again. Id clashes are caught here first from the
// outline (a rename box prefilled with a suggested id) and again from the server's 400 {clash}. Nothing is overwritten.
import { suggestId, slugId } from './patches.mjs';
import { pickField } from './picker.mjs';
import { opposite, sideLabels } from './placeform.mjs';

const ACTIONS = {
    world: [['create_region', 'Create region']],
    region: [['create_subregion', 'Create subregion'], ['delete_region', 'Delete region']],
    subregion: [['create_place', 'Create place'], ['merge_places', 'Merge places'], ['move_subregion', 'Move subregion'], ['delete_subregion', 'Delete subregion']],
    room: [['move_place', 'Move place'], ['delete_place', 'Delete place']],
};
export const actionsFor = kind => ACTIONS[kind] ?? [];

/** Helpers over the outline. */
export function findSub(o, area) { const [rid, sid] = String(area).split(':'); return o.regions.find(r => r.id === rid)?.subregions.find(s => s.id === sid) ?? null; }
export const findRegion = (o, rid) => o.regions.find(r => r.id === rid) ?? null;
export const allRooms = o => o.regions.flatMap(r => r.subregions.flatMap(s => s.rooms.map(x => ({ ...x, label: `${x.name} (${r.name} › ${s.name})` }))));
/** The last-item cascade: what else goes when `what` ("room" address or "subregion" area) leaves its container. */
export function cascadeOf(o, kind, ref) {
    if (kind === 'room') {
        const area = ref.split('/')[0], s = findSub(o, area);
        if (!s || s.rooms.length > 1) return null;
        const r = findRegion(o, area.split(':')[0]);
        return { container: s.name, area, kind: 'subregion', also: r && r.subregions.length <= 1 ? r.name : null };
    }
    const r = findRegion(o, ref.split(':')[0]);
    if (!r || r.subregions.length > 1) return null;
    return { container: r.name, area: r.id, kind: 'region' };
}
/** Clashing ids when `ids` move into a container already holding `taken`: [{id, suggest}]. */
export function clashes(ids, taken, prefix) {
    const t = new Set(taken), out = [];
    for (const id of ids) {
        if (!t.has(id)) { t.add(id); continue; }
        const s = suggestId(t, id, prefix); out.push({ id, suggest: s }); t.add(s);
    }
    return out;
}

export function openAction(doc, pane, action, ctx, io) {
    const $ = (tag, attrs = {}, ...kids) => { const e = doc.createElement(tag); for (const [k, v] of Object.entries(attrs)) { if (k === 'class') e.className = v; else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else if (v !== false && v !== null && v !== undefined) e.setAttribute(k, v === true ? '' : v); } e.append(...kids.flat().filter(x => x !== null && x !== undefined && x !== false)); return e; };
    const row = (label, ctl, extra = {}) => $('label', { class: 'mw-row', ...extra }, $('span', {}, label), ctl);
    const input = (v = '', ph = '') => $('input', { type: 'text', value: v, placeholder: ph });
    const area = (v = '') => { const t = $('textarea', { rows: 3 }); t.value = v; return t; };
    const select = (opts, v) => { const s = $('select', {}, ...opts.map(([k, l]) => $('option', { value: k }, l))); if (v !== undefined) s.value = v; return s; };
    const aiBtn = (ta, spec) => {
        const b = $('button', { type: 'button', class: 'pf-ai mw-ai', title: 'Expand with AI (sees only the parent notes and the places the exits lead to)' }, 'Expand with AI');
        b.addEventListener('click', async () => {
            b.disabled = true; const was = b.textContent; b.textContent = 'Writing…';
            try { const t = await io.aiText({ ...spec(), text: ta.value }); if (t) { ta.value = t; ta.dispatchEvent(new Event('input')); } } catch (e) { b.title = `Expand failed: ${e.message}`; } finally { b.disabled = false; b.textContent = was; }
        });
        return b;
    };
    const box = $('div', { class: 'mapaction', 'data-action': action });
    pane.replaceChildren(box);
    const errs = $('ul', { class: 'pf-errors warnings mw-errors' }), diff = $('div', { class: 'editlive-diff mw-diff' }), status = $('p', { class: 'muted mw-status' });
    const done = ctx.done ?? (() => io.back());
    let build = () => [], tmr = null, renames = null;
    const getOps = () => build();
    const refresh = () => { clearTimeout(tmr); tmr = setTimeout(async () => {
        let o; try { o = getOps(); } catch (e) { errs.replaceChildren($('li', {}, e.message)); diff.replaceChildren(); return; }
        if (!o?.length) { diff.replaceChildren($('p', { class: 'muted' }, 'Fill in the form to see the changes.')); return; }
        try { const pv = await io.preview(o); errs.replaceChildren(); diff.style.opacity = ''; diff.replaceChildren(io.renderDiff(doc, pv)); }
        catch (e) {
            diff.style.opacity = '0.5';
            const c = e.detail?.clash;
            errs.replaceChildren($('li', {}, e.detail?.error ?? e.message));
            if (c && renames) renames.ask(c);
        }
    }, 300); };
    box.addEventListener('input', refresh); box.addEventListener('change', refresh);
    const submit = $('button', { class: 'crumb mw-submit' }, 'Submit');
    submit.addEventListener('click', async () => {
        let o; try { o = getOps(); } catch (e) { errs.replaceChildren($('li', {}, e.message)); return; }
        if (!o?.length) { errs.replaceChildren($('li', {}, 'Nothing to do yet.')); return; }
        submit.disabled = true; status.textContent = 'Saving…';
        const r = await io.submit(o);
        submit.disabled = false;
        if (!r.ok) { errs.replaceChildren(...(r.errors ?? [{ error: r.error ?? 'Not saved.' }]).map(e => $('li', {}, e.error))); status.textContent = 'Not saved.'; return; }
        status.textContent = `Saved as message #${r.msg}: ${(r.summary ?? []).join('; ')}`;
        done(r);
    });
    const cancel = $('button', { class: 'crumb mw-cancel', onclick: () => (ctx.cancel ?? io.back)() }, 'Cancel');
    const o = ctx.outline;

    /** Rename boxes for clashing ids: one row per clash, prefilled with the suggestion. */
    function renameBox(prefixLabel) {
        const el = $('div', { class: 'mw-renames' }), ids = {};
        const api = {
            el, ids,
            set(list) { el.replaceChildren(); for (const k of Object.keys(ids)) delete ids[k]; for (const c of list) api.ask(c, true); },
            ask(c, quiet) {
                if (el.querySelector(`[data-id="${c.id}"]`)) return;
                const inp = input(c.suggest); inp.className = 'mw-rename'; ids[c.id] = c.suggest;
                inp.addEventListener('input', () => { ids[c.id] = slugId(inp.value) || c.suggest; });
                el.append($('div', { class: 'mw-clash', 'data-id': c.id }, $('span', {}, `A ${c.kind === 'subregion' ? 'subregion' : 'place'} with id "${c.id}" is already ${prefixLabel}. Rename the one moving in to:`), inp));
                if (!quiet) refresh();
            },
        };
        return api;
    }
    /** The required last-item cascade: Confirm / Cancel / Add a place first. */
    function cascadeGate(cas, verb, addFirst, then) {
        const what = cas.kind === 'subregion' ? 'place' : 'subregion';
        box.replaceChildren($('h4', {}, verb),
            $('p', { class: 'mw-cascade' }, `${verb === 'Move' ? 'Moving' : 'Deleting'} the last ${what} in ${cas.container} will also delete ${cas.container}${cas.also ? ` (and ${cas.also}, its region's last subregion)` : ''}.`),
            $('div', {}, $('button', { class: 'crumb mw-confirm', onclick: then }, 'Confirm'), cancel,
                $('button', { class: 'crumb mw-addfirst', onclick: addFirst }, `Add a ${what} first`)));
    }
    const addFirstFor = cas => () => openAction(doc, pane, cas.kind === 'subregion' ? 'create_place' : 'create_subregion',
        { ...ctx, target: cas.area, kind: cas.kind, done: async () => { await new Promise(r => setTimeout(r, 900)); openAction(doc, pane, action, { ...ctx, outline: await io.outline() }, io); }, cancel: () => openAction(doc, pane, action, ctx, io) }, io);
    const exitsEditor = (from, min, hereName = () => '') => {
        const list = $('div', { class: 'mw-exits' }), rows = [];
        const roomName = a => allRooms(o).find(r => r.address === a)?.name ?? '';
        const add = () => {
            const to = pickField(doc, { kind: 'room', title: 'exit destination', exclude: from ? [from] : [], outline: o, value: '' }), dir = input('', 'e.g. north'), back = input('', 'e.g. south');
            dir.classList.add('mw-dir'); back.classList.add('mw-back');
            const s1 = $('div', { class: 'mw-side', 'data-side': 'there' }), s2 = $('div', { class: 'mw-side', 'data-side': 'back' });
            const label = () => { const L = sideLabels(hereName().trim() || 'the new place', roomName(to.value) || '?'), [a1, b1] = L.there.split('___'), [a2, b2] = L.back.split('___'); s1.replaceChildren(a1, dir, b1); s2.replaceChildren(a2, back, b2); };
            let auto = true;
            dir.addEventListener('input', () => { if (auto) back.value = opposite(dir.value); });
            back.addEventListener('input', () => { auto = false; });
            to.addEventListener('change', label);
            const r = $('div', { class: 'mw-exit' }, to, s1, s2, $('button', { type: 'button', class: 'crumb', onclick: () => { r.remove(); rows.splice(rows.indexOf(x), 1); refresh(); } }, '×'));
            const x = { to, dir, back, label }; rows.push(x); label(); list.append(r); refresh();
        };
        if (min) add();
        return { el: $('div', {}, $('b', {}, min ? 'Exits (at least one, to an existing place)' : 'Exits (optional)'), list, $('button', { type: 'button', class: 'crumb mw-addexit', onclick: add }, 'Add exit')),
            get: () => rows.filter(x => x.to.value).map(x => ({ to: x.to.value, direction: x.dir.value.trim() || `to ${allRooms(o).find(r => r.address === x.to.value)?.name ?? 'there'}`, ...(x.back.value.trim() ? { return_direction: x.back.value.trim() } : {}) })),
            rooms: () => rows.map(x => x.to.value).filter(Boolean), relabel: () => rows.forEach(x => x.label()) };
    };
    const placeFields = (areaRef, needExit, title = 'Place') => {
        const name = input(), desc = area(), ex = exitsEditor(null, needExit, () => name.value);
        name.addEventListener('input', () => ex.relabel());
        return { els: [row(`${title} name`, name, { 'data-field': 'place_name' }), row(`${title} description`, desc, { 'data-field': 'place_description' }),
            aiBtn(desc, () => ({ field: 'description', kind: 'room', name: name.value, area: areaRef(), rooms: ex.rooms() })), ex.el],
        get() { if (!name.value.trim()) throw new Error(`${title} name is required.`); if (!desc.value.trim()) throw new Error(`${title} description is required.`); const exits = ex.get().map(e => e.return_direction ? e : { ...e, return_direction: `to ${name.value.trim()}` }); if (needExit && !exits.length) throw new Error('A new place needs at least one exit to an existing place.'); return { name: name.value.trim(), description: desc.value.trim(), ...(exits.length ? { exits } : {}) }; } };
    };
    const t = ctx.target, header = (h, ...kids) => box.replaceChildren($('h4', {}, h), ...kids, errs, $('b', {}, 'Changes'), diff, submit, cancel, status);

    switch (action) {
        case 'create_region': {
            const n = input(), notes = area(), sn = input(), snotes = area(), p = placeFields(() => '', true, 'Starting place');
            build = () => { if (!n.value.trim()) throw new Error('Region name is required.'); if (!sn.value.trim()) throw new Error('First subregion name is required.');
                return [{ op: 'create_region', name: n.value.trim(), ...(notes.value.trim() ? { notes: notes.value.trim() } : {}), subregion: { name: sn.value.trim(), ...(snotes.value.trim() ? { notes: snotes.value.trim() } : {}), place: p.get() } }]; };
            header('Create region', $('p', { class: 'muted' }, 'A region needs its first subregion and a starting place.'), row('Region name', n, { 'data-field': 'region_name' }), row('Region notes', notes), aiBtn(notes, () => ({ field: 'notes', kind: 'region', name: n.value, area: '', rooms: [] })),
                row('First subregion name', sn, { 'data-field': 'sub_name' }), row('Subregion notes', snotes), ...p.els);
            break;
        }
        case 'create_subregion': {
            const n = input(), notes = area(), p = placeFields(() => t, true, 'First place');
            build = () => { if (!n.value.trim()) throw new Error('Subregion name is required.'); return [{ op: 'create_subregion', region: t, name: n.value.trim(), ...(notes.value.trim() ? { notes: notes.value.trim() } : {}), place: p.get() }]; };
            header(`Create subregion in ${findRegion(o, t)?.name ?? t}`, row('Subregion name', n, { 'data-field': 'sub_name' }), row('Notes', notes), aiBtn(notes, () => ({ field: 'notes', kind: 'subregion', name: n.value, area: t, rooms: [] })), ...p.els);
            break;
        }
        case 'create_place': {
            // The map's Create place is the Edit place form, empty (all its fields, both sides of each exit, the door).
            if (io.createPlace) { io.createPlace(t, { heading: findSub(o, t)?.name ?? t, ...(ctx.done ? { done: ctx.done } : {}), ...(ctx.cancel ? { cancel: ctx.cancel } : {}) }); return box; }
            const p = placeFields(() => t, true);
            build = () => [{ op: 'create_place', area: t, ...p.get() }];
            header(`Create place in ${findSub(o, t)?.name ?? t}`, ...p.els);
            break;
        }
        case 'merge_places': {
            const s = findSub(o, t), checks = s.rooms.map(r => ({ r, c: $('input', { type: 'checkbox', class: 'mw-merge-pick', value: r.address }) }));
            const n = input(), desc = area();
            build = () => { const locs = checks.filter(x => x.c.checked).map(x => x.r.address); if (locs.length < 2) throw new Error('Pick at least two places to merge.');
                return [{ op: 'merge', locs, area: t, ...(n.value.trim() ? { name: n.value.trim() } : {}), ...(desc.value.trim() ? { description: desc.value.trim() } : {}) }]; };
            header(`Merge places in ${s.name}`, $('div', { class: 'mw-picks' }, ...checks.map(x => $('label', {}, x.c, ` ${x.r.name}`))), row('Merged place name (optional)', n), row('Description (optional)', desc),
                aiBtn(desc, () => ({ field: 'description', kind: 'room', name: n.value, area: t, rooms: checks.filter(x => x.c.checked).map(x => x.r.address) })));
            break;
        }
        case 'delete_place': {
            const cas = cascadeOf(o, 'room', t), name = allRooms(o).find(r => r.address === t)?.name ?? t;
            build = () => [{ op: 'remove_location', loc: t }];
            const show = () => { header(`Delete ${name}`, $('p', {}, `Delete ${name}? Its exits go too; anyone inside ends up in the nearest place. Delete the message in the chat to undo.`)); refresh(); };
            if (cas) cascadeGate(cas, 'Delete', addFirstFor(cas), show); else show();
            return box;
        }
        case 'delete_subregion': case 'delete_region': {
            const isSub = action === 'delete_subregion', [rid, sid] = t.split(':'), me = isSub ? findSub(o, t) : findRegion(o, t);
            const mode = select([['delete', `Delete its ${isSub ? 'places' : 'subregions'} too`], ['move', `Move all its ${isSub ? 'places' : 'subregions'} into…`]], 'delete');
            const into = pickField(doc, isSub ? { kind: 'subregion', title: 'subregion to move its places into', exclude: [t], outline: o } : { kind: 'region', title: 'region to move its subregions into', exclude: [t], outline: o }), rn = renameBox('there');
            const recheck = () => {
                if (mode.value !== 'move') return rn.set([]);
                const ids = isSub ? me.rooms.map(r => r.id) : me.subregions.map(s => s.id);
                const taken = isSub ? (findSub(o, into.value)?.rooms.map(r => r.id) ?? []) : (findRegion(o, into.value)?.subregions.map(s => s.id) ?? []);
                rn.set(clashes(ids, taken, isSub ? sid : rid).map(c => ({ ...c, kind: isSub ? 'room' : 'subregion' })));
            };
            renames = rn;
            mode.addEventListener('change', () => { intoRow.hidden = mode.value !== 'move'; recheck(); }); into.addEventListener('change', recheck);
            const intoRow = row('Into', into, { 'data-field': 'into', hidden: true });
            build = () => { if (mode.value === 'move' && !into.value) throw new Error(`Choose the ${isSub ? 'subregion' : 'region'} to move them into.`); return [{ op: 'remove_area', area: t, contents: mode.value, ...(mode.value === 'move' ? { into: into.value, ...(Object.keys(rn.ids).length ? { ids: { ...rn.ids } } : {}) } : {}) }]; };
            const startBlocked = !isSub && o.start_region === t;
            const show = () => { header(`Delete ${me.name}`, ...(startBlocked ? [$('p', { class: 'mw-blocked' }, `${me.name} is the world's starting region, so it can't be deleted.`)] : []),
                $('p', { class: 'muted' }, `Moving everything into another ${isSub ? 'subregion' : 'region'} is how two ${isSub ? 'subregions' : 'regions'} merge. Old addresses lead to the new ones.`), row('Contents', mode, { 'data-field': 'contents' }), intoRow, rn.el);
                if (startBlocked) submit.disabled = true; refresh(); };
            const cas = isSub ? cascadeOf(o, 'subregion', t) : null;
            if (cas && !(o.start_region === cas.area)) cascadeGate(cas, 'Delete', addFirstFor(cas), show); else show();
            return box;
        }
        case 'move_place': {
            const [a0, id] = [t.split('/')[0], t.split('/')[1]];
            const dest = pickField(doc, { kind: 'subregion', title: 'subregion to move it to', exclude: [a0], outline: o }), rn = renameBox('there'); renames = rn;
            const recheck = () => rn.set(clashes([id], findSub(o, dest.value)?.rooms.map(r => r.id) ?? [], a0.split(':')[1]).map(c => ({ ...c, kind: 'room' })));
            dest.addEventListener('change', recheck);
            build = () => { if (!dest.value) throw new Error('Choose the subregion to move it to.'); return [{ op: 'move_location', loc: t, area: dest.value, ...(rn.ids[id] ? { id: rn.ids[id] } : {}) }]; };
            const show = () => { header(`Move ${allRooms(o).find(r => r.address === t)?.name ?? t}`, $('p', { class: 'muted' }, 'Exits follow it; the old address leads to the new one (turn the change off to undo).'), row('To subregion', dest, { 'data-field': 'dest' }), rn.el); recheck(); refresh(); };
            const cas = cascadeOf(o, 'room', t);
            if (cas) cascadeGate(cas, 'Move', addFirstFor(cas), show); else show();
            return box;
        }
        case 'move_subregion': {
            const [rid, sid] = t.split(':');
            const dest = pickField(doc, { kind: 'region', title: 'region to move it to', exclude: [rid], outline: o }), rn = renameBox('there'); renames = rn;
            const recheck = () => rn.set(clashes([sid], findRegion(o, dest.value)?.subregions.map(s => s.id) ?? [], rid).map(c => ({ ...c, kind: 'subregion' })));
            dest.addEventListener('change', recheck);
            build = () => { if (!dest.value) throw new Error('Choose the region to move it to.'); return [{ op: 'move_area', area: t, region: dest.value, ...(rn.ids[sid] ? { id: rn.ids[sid] } : {}) }]; };
            const show = () => { header(`Move ${findSub(o, t)?.name ?? t}`, $('p', { class: 'muted' }, 'All its places move with it; old addresses lead to the new ones.'), row('To region', dest, { 'data-field': 'dest' }), rn.el); recheck(); refresh(); };
            const cas = cascadeOf(o, 'subregion', t);
            if (cas && o.start_region !== cas.area) cascadeGate(cas, 'Move', addFirstFor(cas), show); else show();
            return box;
        }
        default: box.append($('p', {}, `Unknown action ${action}`));
    }
    refresh();
    return box;
}
