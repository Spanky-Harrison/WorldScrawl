// Top-bar menus (Tools, Debug), built from registries. A menu item is {id, label, open()} (an action), or
// {id, label, toggle: true, checked(), set(on)} (shows a checkmark). A full-view tool calls openToolView() in its open():
// it takes over the whole window below the top bar, with the same title bar and Close button as every other tool.
// Adding a tool = one entry in TOOLS + its view function. See README "Adding a tool".
const h = (tag, attrs = {}, ...kids) => { const el = document.createElement(tag); for (const [k, v] of Object.entries(attrs)) { if (k === 'class') el.className = v; else if (k.startsWith('on')) el.addEventListener(k.slice(2), v); else if (v !== false && v != null) el.setAttribute(k, v === true ? '' : v); } el.append(...kids.flat().filter(x => x != null && x !== false)); return el; };

/** Check a registry: unique ids, a label, and either open() or a toggle's checked()/set(). Returns the problems. */
export function registryProblems(items) {
    const out = [], ids = new Set();
    for (const it of items) {
        if (!it?.id || ids.has(it.id)) out.push(`bad or duplicate id: ${it?.id}`); ids.add(it?.id);
        if (!it?.label) out.push(`${it?.id}: no label`);
        if (it?.toggle ? typeof it.checked !== 'function' || typeof it.set !== 'function' : typeof it?.open !== 'function') out.push(`${it?.id}: needs ${it?.toggle ? 'checked() and set()' : 'open()'}`);
    }
    return out;
}
let openMenu = null;
const closeMenus = () => { openMenu?.classList.remove('open'); openMenu?.querySelector('.menu-title')?.setAttribute('aria-expanded', 'false'); openMenu = null; };
if (typeof document !== 'undefined') {
    document.addEventListener('click', ev => { if (openMenu && !openMenu.contains(ev.target)) closeMenus(); });
    document.addEventListener('keydown', ev => { if (ev.key === 'Escape') closeMenus(); });
}
/** A classic File-menu style dropdown. */
export function buildMenu(id, title, items) {
    const list = h('div', { class: 'menu-list', role: 'menu' });
    const root = h('div', { class: 'menu', id: `menu-${id}` });
    const fill = () => {
        list.replaceChildren(...items.map(it => h('button', { type: 'button', role: it.toggle ? 'menuitemcheckbox' : 'menuitem', class: 'menu-item', 'data-item': it.id,
            ...(it.toggle ? { 'aria-checked': String(!!it.checked()) } : {}),
            onclick: ev => { ev.stopPropagation(); closeMenus(); if (it.toggle) it.set(!it.checked()); else it.open(); } },
        h('span', { class: 'menu-check' }, it.toggle && it.checked() ? '✓' : ''), h('span', {}, it.label))));
    };
    const btn = h('button', { type: 'button', class: 'menu-title', 'aria-haspopup': 'true', 'aria-expanded': 'false', onclick: ev => {
        ev.stopPropagation();
        const was = openMenu === root; closeMenus();
        if (!was) { fill(); root.classList.add('open'); btn.setAttribute('aria-expanded', 'true'); openMenu = root; }
    } }, title);
    root.append(btn, list);
    return root;
}
/** A small modal with one button per choice; resolves to the label clicked (Escape = the last one). */
export function choose(message, buttons) {
    return new Promise(res => {
        const done = b => { box.remove(); document.removeEventListener('keydown', key, true); res(b); };
        const key = ev => { if (ev.key === 'Escape') { ev.stopPropagation(); done(buttons[buttons.length - 1]); } };
        const box = h('div', { class: 'ws-choose-back' }, h('div', { class: 'ws-choose', role: 'alertdialog', 'aria-label': message }, h('p', {}, message),
            h('div', { class: 'ws-choose-buttons' }, buttons.map(b => h('button', { type: 'button', class: 'topbutton', 'data-choice': b, onclick: () => done(b) }, b)))));
        document.addEventListener('keydown', key, true);
        document.body.append(box);
        box.querySelector('button')?.focus();
    });
}
/** Show a full-view tool: hides the normal windows. Only one tool is open at a time: opening one first closes the open one
 * (which may ask about unsaved edits and refuse). Resolves to the view, or null when the open tool stayed. */
export async function openToolView(id, title, build) {
    if (!(await closeToolView())) return null;
    const body = h('div', { class: 'toolview-body' });
    const view = h('section', { class: 'toolview', id: `tool-${id}`, 'data-tool': id },
        h('header', { class: 'toolview-head' }, h('h2', {}, title), h('button', { type: 'button', class: 'topbutton toolview-close', onclick: () => closeToolView() }, 'Close')), body);
    document.getElementById('windows').hidden = true;
    document.body.append(view);
    const r = build(body, { close: closeToolView });
    view._onClose = r?.onClose;
    return view;
}
/** Close the open tool, if any. Resolves false when the tool said no (e.g. the user chose Stay on unsaved edits). */
export async function closeToolView() {
    const v = document.querySelector('.toolview');
    if (!v) return true;
    if (v._onClose && (await v._onClose()) === false) return false;
    v.remove();
    document.getElementById('windows').hidden = false;
    return true;
}
/** Top-bar view buttons (the map and other windows, Editor) close the open tool first; if it stays open, the click is dropped. */
export function guardViewButtons(nav) {
    nav.addEventListener('click', ev => {
        const b = ev.target.closest('button');
        if (!b || b._wsPass || !document.querySelector('.toolview')) return;
        ev.preventDefault(); ev.stopImmediatePropagation();
        closeToolView().then(ok => { if (ok) { b._wsPass = true; try { b.click(); } finally { b._wsPass = false; } } });
    }, true);
}
