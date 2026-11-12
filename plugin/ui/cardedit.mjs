// The one editor every card opens with Edit: the shared "Change:" box (what Rewrite with this asks again with), one box
// per field the card's panel shows, and, for map changes, the patch form hosted in the same frame. Pure DOM.
// Typed text survives redraws: drafts are kept here, keyed on the card's stable key plus the field key (never a
// decision revision), a field the player changed (dirty) is never overwritten by incoming data, and the caret and
// selection come back after a redraw.

const drafts = new Map(); // card key -> { open, fields: Map(field key -> {value, base, dirty, sel, focus}), extra }

function draftOf(key) {
    let d = drafts.get(key);
    if (!d) { d = { open: false, fields: new Map(), extra: {} }; drafts.set(key, d); }
    return d;
}
/** Is this card's editor open? */
export const editorOpen = key => !!drafts.get(key)?.open;
/** Open the editor (extra: anything the card type keeps with it, e.g. the map form). */
export function openCardEditor(key, extra = {}) { const d = draftOf(key); d.open = true; Object.assign(d.extra, extra); return d; }
/** Close the editor and forget what was typed. */
export function closeCardEditor(key) { drafts.delete(key); }
/** What the card keeps with its open editor (or null). */
export const editorExtra = key => (drafts.get(key)?.open ? drafts.get(key).extra : null);
/** The editor's current values, readable after the boxes were redrawn: {intent, fields: {key: value}, dirty: [keys]}. */
export function editorValues(key) {
    const d = drafts.get(key);
    if (!d) return { intent: '', fields: {}, dirty: [] };
    const fields = {}, dirty = [];
    let intent = '';
    for (const [k, f] of d.fields) {
        if (k === '_intent') { intent = f.value; if (f.dirty) dirty.push(k); continue; }
        fields[k] = f.value;
        if (f.dirty) dirty.push(k);
    }
    return { intent, fields, dirty };
}
/** Fields the player changed (never the Change box). */
export const dirtyFields = key => editorValues(key).dirty.filter(k => k !== '_intent');

const STYLE = { text: 'width:16em;', amount: 'width:9em;', place: 'width:18em;', intent: 'width:20em;' };

/**
 * Build the editor. ed: {key, intent: {label, value, cls, title} | null, fields: [{key, label, value, kind, cls, data,
 * placeholder}], formEl}. kind 'textarea' (default) | 'text' | 'amount' | 'place' | 'list'. Returns
 * {el, values(), intent(), dirty(), setErrors(list), destroy()}.
 */
export function buildCardEditor(doc, ed) {
    const d = openCardEditor(ed.key);
    const el = doc.createElement('div');
    el.className = 'worldscrawl_card_editor';
    const controls = [];
    const bind = (fkey, ctl, incoming) => {
        let s = d.fields.get(fkey);
        if (!s) { s = { value: incoming, base: incoming, dirty: false, sel: null, focus: false }; d.fields.set(fkey, s); }
        if (!s.dirty) { s.value = incoming; s.base = incoming; } else s.base = incoming; // only clean fields follow new data
        ctl.value = s.value;
        const keepSel = () => { if (typeof ctl.selectionStart === 'number') s.sel = [ctl.selectionStart, ctl.selectionEnd ?? ctl.selectionStart]; };
        ctl.addEventListener('click', e => { e.stopPropagation(); keepSel(); });
        ctl.addEventListener('input', () => { s.value = ctl.value; s.dirty = s.value !== s.base; keepSel(); });
        ctl.addEventListener('keyup', keepSel);
        ctl.addEventListener('select', keepSel);
        ctl.addEventListener('focus', () => { s.focus = true; });
        ctl.addEventListener('blur', () => { s.focus = false; keepSel(); });
        if (s.sel) { ctl.selectionStart = s.sel[0]; ctl.selectionEnd = s.sel[1]; }
        if (s.focus || s.sel) {
            // Back where the player left it once the redrawn card is in the page.
            const restore = () => { if (!ctl.isConnected) return; if (s.focus) ctl.focus?.(); if (s.sel) ctl.setSelectionRange?.(s.sel[0], s.sel[1]); };
            (globalThis.queueMicrotask ?? (f => Promise.resolve().then(f)))(restore);
        }
        controls.push({ key: fkey, ctl });
        return ctl;
    };
    if (ed.intent) {
        const inp = doc.createElement('input');
        inp.type = 'text'; inp.className = ['text_pole', 'worldscrawl_card_input', 'worldscrawl_card_intent', ed.intent.cls].filter(Boolean).join(' ');
        if (ed.intent.title) inp.title = ed.intent.title;
        inp.style.cssText = `${STYLE.intent}display:inline-block;margin:0 4px;padding:1px 4px;`;
        bind('_intent', inp, String(ed.intent.value ?? ''));
        const line = doc.createElement('div'); line.className = 'worldscrawl_notice_fields';
        line.style.cssText = 'display:flex;flex-wrap:wrap;align-items:center;gap:4px;margin-top:2px;';
        line.append(ed.intent.label ?? 'Change:', inp);
        el.append(line);
    }
    for (const f of ed.fields ?? []) {
        const kind = f.kind || 'textarea';
        const ctl = doc.createElement(kind === 'textarea' || kind === 'list' ? 'textarea' : 'input');
        if (kind !== 'textarea' && kind !== 'list') ctl.type = 'text';
        ctl.className = ['text_pole', kind === 'textarea' || kind === 'list' ? 'worldscrawl_card_area' : 'worldscrawl_card_input', 'worldscrawl_card_field', f.cls].filter(Boolean).join(' ');
        ctl.dataset.field = f.key;
        for (const [k, v] of Object.entries(f.data ?? {})) ctl.dataset[k] = v;
        if (f.placeholder) ctl.placeholder = f.placeholder;
        if (f.title) ctl.title = f.title;
        if (kind === 'textarea' || kind === 'list') { ctl.rows = f.rows ?? 3; ctl.style.cssText = 'width:100%;margin:2px 0;padding:2px 4px;'; }
        else ctl.style.cssText = `${STYLE[kind] ?? STYLE.text}display:inline-block;margin:0 4px;padding:1px 4px;`;
        bind(f.key, ctl, String(f.value ?? ''));
        const cap = doc.createElement('div'); cap.className = 'wsdiff-label'; cap.textContent = f.label ?? f.key;
        if (kind === 'textarea' || kind === 'list') el.append(cap, ctl);
        else { const line = doc.createElement('div'); line.className = 'worldscrawl_notice_fields'; line.style.cssText = 'display:flex;flex-wrap:wrap;align-items:center;gap:4px;margin-top:2px;'; line.append(`${f.label ?? f.key}:`, ctl); el.append(line); }
    }
    if (ed.formEl) el.append(ed.formEl);
    const err = doc.createElement('div'); err.className = 'worldscrawl_card_error'; err.hidden = true; err.style.color = '#e55';
    el.append(err);
    const api = {
        el,
        values: () => editorValues(ed.key).fields,
        intent: () => editorValues(ed.key).intent,
        dirty: () => editorValues(ed.key).dirty.length > 0,
        setErrors(list = []) { const t = list.map(x => (x.field ? `${x.field}: ${x.error}` : x.error)).filter(Boolean).join(' '); err.textContent = t; err.hidden = !t; },
        destroy: () => closeCardEditor(ed.key),
    };
    return api;
}
