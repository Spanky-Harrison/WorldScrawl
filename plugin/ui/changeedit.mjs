// The change editor tab: Edit on a "Map changed here" bar in SillyTavern opens plugin/ui/?edit=1&chat=..&msg=..&swipe=..&change=..&hash=..
// It shows that one change as place forms (one tab per touched place, the map picker for moves and exits), each form
// starting from the map as it is right after the change. Saving sends the change plus the form edits back to the
// SillyTavern tab, which re-checks chat, message, swipe and change before it rewrites the stamp (or refuses with a note).
// Raw JSON is the advanced view: edit the ops directly. The server is never written to.

/** The session fields from the URL, or null when this is not a change editor tab. */
export function sessionFromUrl(search) {
    const q = new URLSearchParams(search ?? '');
    if (q.get('edit') !== '1') return null;
    const s = Object.fromEntries(['chat', 'msg', 'swipe', 'change', 'hash'].map(k => [k, q.get(k) ?? '']));
    return s.chat && s.msg !== '' && s.change ? s : null;
}
/** The form target for a touched address or area: rooms as-is, "region:sub" -> sub:, "region" -> region:. */
export const targetOf = a => (String(a).includes('/') ? a : String(a).includes(':') ? `sub:${a}` : `region:${a}`);
/** Touched places first (rooms before areas), each once, in order. */
export function touchedTargets(touched = []) {
    const seen = new Set(), rooms = [], areas = [];
    for (const a of touched) { if (!a || seen.has(a)) continue; seen.add(a); (String(a).includes('/') ? rooms : areas).push(a); }
    return [...rooms, ...areas].map(targetOf);
}
/** The new change: the original ops, then each form's edits on top (forms start from the map right after the change). */
export const combineOps = (orig, formOps) => [...(orig ?? []), ...formOps.flat()];

/**
 * Build the editor into `root`. io: {ask(type, payload) -> Promise<reply>, post(path, body) -> json, buildEditForm, renderDiff, outline?}
 */
export async function openChangeEditor(doc, root, session, io) {
    const $ = (tag, attrs = {}, ...kids) => { const el = doc.createElement(tag); for (const [k, v] of Object.entries(attrs)) { if (k === 'class') el.className = v; else if (k.startsWith('on')) el.addEventListener(k.slice(2), v); else if (v !== false && v !== null && v !== undefined) el.setAttribute(k, v === true ? '' : v); } el.append(...kids.flat().filter(x => x !== null && x !== undefined && x !== false)); return el; };
    root.replaceChildren($('p', { class: 'muted' }, 'Asking SillyTavern for the change…'));
    const s = await io.ask('change_open', { session });
    if (!s?.ok) { root.replaceChildren($('div', { class: 'change-editor stale' }, $('h3', {}, 'Can\'t edit this change'), $('p', {}, (s?.errors ?? []).map(e => e.error).join(' ') || 'No answer from SillyTavern. Is the chat open in a tab?'))); return null; }
    const q = s.world ? `?world=${encodeURIComponent(s.world)}` : '';
    const before = { changes: s.before ?? [], now: s.now ?? null }, after = { changes: s.with ?? [], now: s.now ?? null };
    let first;
    try { first = await io.post(`/patch/preview${q}`, { patch: { ops: s.ops }, ...before }); } catch (e) { first = { touched: [], summary: s.summary, error: e.message }; }
    let outline = null; try { outline = await io.post(`/edit/outline${q}`, after); } catch { /* plain dropdowns */ }
    const targets = touchedTargets(first.touched ?? []);
    const forms = [];
    const diffBox = $('div', { class: 'editlive-diff' }), errBox = $('ul', { class: 'pf-errors warnings' }), status = $('p', { class: 'muted ce-status' }, '');
    const raw = $('textarea', { class: 'ce-raw', rows: 12, spellcheck: 'false' });
    let rawDirty = false;
    raw.addEventListener('input', () => { rawDirty = true; redraw(); });
    const currentOps = () => {
        if (rawDirty) { const v = JSON.parse(raw.value); if (!Array.isArray(v)) throw new Error('Raw JSON must be a list of ops: [ {...}, ... ]'); return v; }
        return combineOps(s.ops, forms.map(f => f.form.getOps()));
    };
    let tmr = null;
    const redraw = () => { clearTimeout(tmr); tmr = setTimeout(async () => {
        let ops; try { ops = currentOps(); } catch (e) { errBox.replaceChildren($('li', {}, e.message)); return; }
        if (!rawDirty) raw.value = JSON.stringify(ops, null, 2);
        try { const pv = await io.post(`/patch/preview${q}`, { patch: { ops }, ...before }); errBox.replaceChildren(); diffBox.style.opacity = ''; diffBox.replaceChildren(io.renderDiff(doc, pv)); }
        catch (e) { diffBox.style.opacity = '0.5'; errBox.replaceChildren($('li', {}, e.message)); }
    }, 300); };
    const tabBar = $('div', { class: 'tabs ce-tabs' }), pane = $('div', { class: 'tabpane ce-pane' });
    for (const t of targets) {
        let ectx; try { ectx = await io.post(`/edit/context${q}`, { target: t, ...after }); } catch (e) { continue; }
        if (!ectx) continue;
        ectx.outline = outline;
        const form = io.buildEditForm(doc, ectx, { onChange: () => redraw() });
        const box = $('div', { class: 'ce-place', 'data-target': t }, form.el); box.hidden = true;
        forms.push({ t, form, box, title: ectx.title ?? t });
        pane.append(box);
    }
    const show = i => forms.forEach((f, j) => { f.box.hidden = i !== j; tabBar.children[j]?.classList.toggle('active', i === j); });
    forms.forEach((f, i) => tabBar.append($('button', { class: 'tab ce-tab', 'data-target': f.t, onclick: () => show(i) }, f.title)));
    show(0);
    const save = $('button', { class: 'crumb pf-submit ce-save', onclick: async () => {
        const probs = forms.flatMap(f => f.form.problems?.() ?? []);
        if (probs.length) { errBox.replaceChildren(...probs.map(p => $('li', {}, p))); return; }
        let ops; try { ops = currentOps(); } catch (e) { errBox.replaceChildren($('li', {}, e.message)); return; }
        save.disabled = true; status.textContent = 'Saving…';
        const r = await io.ask('change_save', { session, ops });
        save.disabled = false;
        if (!r?.ok) { errBox.replaceChildren(...(r?.errors ?? [{ error: 'No answer from SillyTavern. Is the chat open in a tab?' }]).map(e => $('li', {}, e.error))); status.textContent = r?.stale ? 'Not saved: the chat changed since this editor opened.' : 'Not saved.'; return; }
        if (r.hash) session.hash = r.hash; // later saves from this tab edit the saved version
        status.textContent = `Saved on message #${session.msg}: ${(r.summary ?? []).join('; ')}`;
        root.querySelector('.change-editor')?.classList.add('saved');
    } }, 'Save change');
    root.replaceChildren($('div', { class: 'change-editor' },
        $('h3', {}, `Edit map change on message #${session.msg}`),
        $('p', { class: 'muted' }, (s.summary ?? []).join('; ') || s.note || ''),
        forms.length ? [$('p', { class: 'muted' }, 'Each tab is a place this change touches, as it is right after the change. Edit it like any place; Save puts the result back on the message.'), tabBar, pane]
            : $('p', { class: 'muted' }, 'This change touches no place that has a form. Use Raw JSON below.'),
        $('b', {}, 'Changes'), diffBox, errBox,
        $('details', { class: 'ce-raw-box' }, $('summary', {}, 'Raw JSON (advanced)'), $('p', { class: 'muted' }, 'The whole change as ops. Typing here replaces the forms until you reload.'), raw),
        save, status));
    redraw();
    return { forms, currentOps, save };
}
