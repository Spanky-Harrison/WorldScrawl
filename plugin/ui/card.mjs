// One card for every review, change and notice: in chat (the extension loads this file from <server>/ui/ at startup)
// and in the map window. Pure DOM, like diffview.mjs. renderCard(doc, desc, onAction) draws a card from a descriptor
// (plugin/shared/cards.mjs builds them): title, summary list, notes, one red/green panel, the shared editor, then ONE
// right-aligned button row. The card only orders and labels the buttons; each type's adapter says which appear.
import { renderDiff, renderPersonDiff } from './diffview.mjs';
import { buildCardEditor } from './cardedit.mjs';

/** Bumped when the descriptor or editor shape changes: the extension refuses a plugin with another version. */
export const CARD_VERSION = 1;

/** The canonical button order. Adapters list actions; the card sorts them into this order. */
export const ORDER = ['again', 'edit', 'close', 'scope', 'extra', 'rewrite', 'approve', 'save', 'off', 'on', 'undo', 'discard'];
const LABELS = { again: 'Check again', edit: 'Edit', close: 'Close editor', rewrite: 'Rewrite with this', approve: 'Approve', save: 'Approve edited', off: 'Turn off', on: 'Turn on', undo: 'Undo', discard: 'Discard' };
const EXTRA_LABELS = { newroom: 'Make it a new room instead' };
const baseOf = id => (String(id).startsWith('extra:') ? 'extra' : String(id));

/** The label the card gives an action. Approve reads "Approve edited" while the editor is open; Discard reads
 *  "Dismiss" on an info notice; the scope switch names where it goes. */
export function actionLabel(a, { editing = false, state = '' } = {}) {
    const id = String(a.id);
    if (id === 'approve' && editing) return 'Approve edited';
    if (id === 'discard' && state === 'info') return 'Dismiss';
    if (id === 'scope') return a.to === 'light' ? 'Make it a light touch' : 'Make it a full rewrite';
    if (id.startsWith('extra:')) return EXTRA_LABELS[id.slice(6)] ?? id.slice(6);
    return LABELS[id] ?? id;
}
/** The actions in canonical order (a stable sort: adapters can't reorder them). */
export function orderActions(actions = []) {
    return actions.filter(Boolean).map((a, i) => ({ a, i })).sort((x, y) => (ORDER.indexOf(baseOf(x.a.id)) - ORDER.indexOf(baseOf(y.a.id))) || x.i - y.i).map(x => x.a);
}

/** The button row at the end of a card (right-aligned). */
export function noticeRow(doc, buttons) {
    const row = doc.createElement('div');
    row.className = 'worldscrawl_notice_row';
    row.style.cssText = 'display:flex;flex-wrap:wrap;justify-content:flex-end;align-items:center;gap:4px;margin-top:4px;';
    for (const b of buttons.filter(Boolean)) row.append(b);
    return row;
}
/** Lock a row at once (first click): every button disabled, a "Saving…" label. False when it was already locked. */
export function lockRow(row, text = 'Saving…') {
    if (!row || row.dataset.locked) return false;
    row.dataset.locked = '1';
    for (const b of row.querySelectorAll('.worldscrawl_card_btn')) { b.classList.add('disabled'); b.setAttribute('aria-disabled', 'true'); b.style.pointerEvents = 'none'; b.style.opacity = '0.5'; }
    const s = row.ownerDocument.createElement('span'); s.className = 'worldscrawl_saving'; s.textContent = text; s.style.cssText = 'opacity:.8;font-style:italic;margin-right:auto;';
    row.prepend(s);
    return true;
}
/** Mark a card as waiting on the player: accent frame and a "⏳ Waiting on you" label first. */
export function markPending(el) {
    el.classList.add('worldscrawl_notice', 'worldscrawl_pending');
    const l = el.ownerDocument.createElement('div'); l.className = 'worldscrawl_waiting_label'; l.textContent = '⏳ Waiting on you';
    el.prepend(l);
    return el;
}
export const CARD_CSS = `.worldscrawl_notice.worldscrawl_pending{border:1px solid var(--SmartThemeQuoteColor,#e8a33d)!important;border-left-width:4px!important;background:color-mix(in srgb,var(--SmartThemeQuoteColor,#e8a33d) 12%,transparent);border-radius:6px;padding:4px 8px;margin:4px 0;}
.worldscrawl_waiting_label{font-weight:bold;font-size:.85em;color:var(--SmartThemeQuoteColor,#e8a33d);margin-bottom:2px;}
.worldscrawl_resolved{opacity:.75;font-size:.95em;}
.worldscrawl_card_input{display:inline-block;margin:0 4px;padding:1px 4px;}
.worldscrawl_card_area{width:100%;margin:2px 0;padding:2px 4px;}`;
/** Text for a decided card ("✓ Approved: …"). */
export function resolvedText(d) {
    const verb = { approve: 'Approved', adjust: 'Approved (adjusted)', discard: 'Discarded' }[d?.action] ?? 'Done';
    return `✓ ${verb}${d?.text ? `: ${d.text}` : ''}`;
}

/**
 * A card button. decides: answering the card (Approve, Discard, Check again…): the first click locks the whole row
 * ("Saving…"), later clicks are ignored, and `after` redraws when the work is done (the write itself is decide-once).
 */
export function cardButton(doc, label, onClick, title = '', decides = false, { onError = null, after = null } = {}) {
    const b = doc.createElement('span');
    b.className = 'menu_button worldscrawl_card_btn'; b.textContent = label; if (title) b.title = title;
    b.style.cssText = 'display:inline-block;padding:2px 8px;margin:0;font-size:0.9em;white-space:nowrap;width:auto;';
    if (decides) b.dataset.decides = '1';
    b.addEventListener('click', e => {
        e.stopPropagation();
        if (!decides) return onClick();
        const row = b.closest('.worldscrawl_notice_row');
        if (row && !lockRow(row)) return; // already saving
        Promise.resolve().then(onClick).catch(err => { if (onError) onError(err); else console.error('[WorldScrawl] card', err); }).finally(() => { if (row?.isConnected) after?.(); });
    });
    return b;
}
/** A label plus inline fields in one wrapping line (the story-range picker, the Change box). */
export function fieldsLine(doc, ...els) {
    const f = doc.createElement('div'); f.className = 'worldscrawl_notice_fields';
    f.style.cssText = 'display:flex;flex-wrap:wrap;align-items:center;gap:4px;margin-top:2px;';
    f.append(...els.filter(Boolean));
    return f;
}

/**
 * Draw one card. desc: {key, type, state, pending, cls, title, summary, notes:[{text, tone, cls}], panel, extras,
 * editor, actions:[{id, title, decides, to}], resolved}. onAction(id, action) runs a click; hooks {onError, after}.
 * Sections always come in this order: title, summary, notes, panel, editor, extras, the one button row.
 */
export function renderCard(doc, desc, onAction = () => {}, hooks = {}) {
    const el = doc.createElement('div');
    el.className = ['worldscrawl_card', desc.type ? `worldscrawl_card_${desc.type}` : '', desc.cls ?? ''].filter(Boolean).join(' ');
    if (desc.key) el.dataset.card = String(desc.key);
    if (desc.state) el.dataset.state = desc.state;
    if (desc.pending) markPending(el);
    if (desc.state === 'off') el.style.opacity = '0.6';
    const div = (cls, text) => { const d = doc.createElement('div'); if (cls) d.className = cls; if (text != null) d.textContent = text; return d; };
    if (desc.title) el.append(div(['worldscrawl_card_title', desc.titleCls].filter(Boolean).join(' '), desc.title));
    if (desc.summary?.length) {
        const ul = doc.createElement('ul'); ul.className = 'worldscrawl_card_summary'; ul.style.margin = '2px 0 4px 1.2em';
        for (const s of desc.summary) { const li = doc.createElement('li'); li.textContent = s; ul.append(li); }
        el.append(ul);
    }
    for (const n of desc.notes ?? []) {
        if (!n?.text) continue;
        const d = div(n.cls || `worldscrawl_note_${n.tone || 'muted'}`, n.text);
        d.dataset.tone = n.tone || 'muted';
        if (n.tone === 'muted') { d.style.opacity = '0.7'; d.style.fontSize = '0.9em'; }
        el.append(d);
    }
    if (desc.panel) {
        const box = div('worldscrawl_diff');
        const p = desc.panel;
        if (p.type === 'place' && p.preview) { const pv = p.preview; box.append(renderDiff(doc, { before: pv.before ?? {}, after: pv.after ?? {}, ops: pv.ops ?? [], relocate: pv.relocate ?? {}, inherit: pv.inherit ?? {}, names: pv.names ?? {} })); }
        else if (p.type === 'fields') box.append(renderPersonDiff(doc, { title: p.title ?? '', tag: p.tag ?? 'person', rows: p.rows ?? [] }));
        el.append(box);
        el._panel = box;
    }
    if (desc.editor) {
        const ed = buildCardEditor(doc, desc.editor);
        el.append(ed.el);
        el._editor = ed;
    }
    for (const x of desc.extras ?? []) if (x) el.append(x);
    const editing = !!desc.editor;
    const buttons = orderActions(desc.actions).map(a => cardButton(doc, actionLabel(a, { editing, state: desc.state }), () => onAction(a.id, a), a.title ?? '', !!a.decides, hooks));
    if (buttons.length) el.append(noticeRow(doc, buttons));
    if (desc.locked) lockRow(el.querySelector('.worldscrawl_notice_row'));
    return el;
}
