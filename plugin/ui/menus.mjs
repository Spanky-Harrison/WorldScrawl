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
/** Show a full-view tool: hides the normal windows; Close (or opening another tool) brings them back. */
export function openToolView(id, title, build) {
    closeToolView();
    const body = h('div', { class: 'toolview-body' });
    const view = h('section', { class: 'toolview', id: `tool-${id}`, 'data-tool': id },
        h('header', { class: 'toolview-head' }, h('h2', {}, title), h('button', { type: 'button', class: 'topbutton toolview-close', onclick: () => closeToolView() }, 'Close')), body);
    document.getElementById('windows').hidden = true;
    document.body.append(view);
    const r = build(body, { close: closeToolView });
    view._onClose = r?.onClose;
    return view;
}
export function closeToolView() {
    const v = document.querySelector('.toolview');
    if (!v) return true;
    if (v._onClose && v._onClose() === false) return false; // the tool said no (e.g. unsaved edits)
    v.remove();
    document.getElementById('windows').hidden = false;
    return true;
}
