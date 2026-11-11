// A tiny DOM for card tests: enough of createElement, classes, querySelector and click.
function matchOne(el, part) {
    let rest = part;
    if (rest[0] !== '.' && rest[0] !== '#' && rest[0] !== '[') {
        const tag = rest.split(/[#.\[]/)[0];
        if (tag && el.tag !== tag) return false;
        rest = rest.slice(tag.length);
    }
    while (rest) {
        if (rest[0] === '.') {
            const m = /^\.([^.#[\]]+)/.exec(rest);
            if (!m || !el.className.split(/\s+/).includes(m[1])) return false;
            rest = rest.slice(m[0].length);
        } else if (rest[0] === '#') {
            const m = /^#([^.#\[]+)/.exec(rest);
            if (!m || el.id !== m[1]) return false;
            rest = rest.slice(m[0].length);
        } else if (rest[0] === '[') {
            const m = /^\[([^\]=]+)(?:="([^"]*)")?\]/.exec(rest);
            if (!m) return false;
            const v = el.getAttribute(m[1]);
            if (v == null || (m[2] != null && v !== m[2])) return false;
            rest = rest.slice(m[0].length);
        } else return false;
    }
    return true;
}
function matchesDesc(el, parts) {
    if (!matchOne(el, parts[parts.length - 1])) return false;
    let i = parts.length - 2, p = el.parent;
    while (i >= 0 && p) { if (matchOne(p, parts[i])) i--; p = p.parent; }
    return i < 0;
}
class El {
    constructor(doc, tag) {
        this.ownerDocument = doc; this.tag = tag; this.children = []; this.parent = null;
        this.className = ''; this.id = ''; this._text = ''; this.attrs = {}; this.listeners = {};
        this.style = {}; this.dataset = {}; this.hidden = false; this.disabled = false; this.title = ''; this.value = '';
    }
    get parentNode() { return this.parent; }
    get childNodes() { return this.children; }
    appendChild(x) { this.append(x); return x; }
    insertBefore(x, before) { if (!x) return x; x.parent = this; const i = this.children.indexOf(before); if (i < 0) this.children.push(x); else this.children.splice(i, 0, x); return x; }
    get classList() {
        const el = this;
        const names = () => el.className.split(/\s+/).filter(Boolean);
        return {
            add: (...xs) => { el.className = [...new Set([...names(), ...xs])].join(' '); },
            remove: (...xs) => { const drop = new Set(xs); el.className = names().filter(n => !drop.has(n)).join(' '); },
            toggle: (x, force) => { const on = force === undefined ? !names().includes(x) : !!force; if (on) el.className = [...new Set([...names(), x])].join(' '); else el.className = names().filter(n => n !== x).join(' '); return on; },
            contains: x => names().includes(x),
        };
    }
    set textContent(v) { this._text = String(v ?? ''); this.children = []; }
    get textContent() { return this._text + this.children.map(c => c.textContent ?? '').join(''); }
    setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'id') this.id = String(v); if (k === 'class') this.className = String(v); }
    getAttribute(k) { if (k === 'id') return this.id || null; if (k === 'class') return this.className || null; return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; }
    addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
    dispatchEvent(ev) { for (const fn of this.listeners[ev?.type] ?? []) fn({ ...ev, target: this, stopPropagation() {}, preventDefault() {} }); }
    append(...xs) {
        for (const x of xs.flat()) {
            if (x == null || x === false) continue;
            if (typeof x !== 'object') { const t = this.ownerDocument.createElement('span'); t.textContent = String(x); t.parent = this; this.children.push(t); }
            else { x.parent = this; this.children.push(x); }
        }
    }
    prepend(x) { if (!x) return; x.parent = this; this.children.unshift(x); }
    remove() { if (this.parent) this.parent.children = this.parent.children.filter(c => c !== this); this.parent = null; }
    replaceChildren(...xs) { this.children = []; this._text = ''; this.append(...xs); }
    get isConnected() { let p = this; while (p) { if (p === this.ownerDocument) return true; p = p.parent; } return false; }
    closest(sel) { let p = this; while (p && p !== this.ownerDocument) { if (matchOne(p, sel)) return p; p = p.parent; } return null; }
    querySelectorAll(sel) { const out = [], parts = sel.trim().split(/\s+/); const walk = n => { for (const c of n.children ?? []) { if (matchesDesc(c, parts)) out.push(c); walk(c); } }; walk(this); return out; }
    querySelector(sel) { return this.querySelectorAll(sel)[0] ?? null; }
    click() { for (const fn of this.listeners.click ?? []) fn({ stopPropagation() {}, preventDefault() {}, target: this, type: 'click' }); }
}
export function makeDoc(ids = [0]) {
    const doc = new El(null, 'document');
    doc.ownerDocument = doc;
    doc.createElement = tag => new El(doc, tag);
    doc.createTextNode = text => { const t = new El(doc, 'text'); t.textContent = String(text ?? ''); return t; };
    doc.defaultView = {};
    doc.documentElement = doc.createElement('html');
    doc.body = doc.createElement('body');
    doc.append(doc.documentElement);
    const chat = doc.createElement('div');
    chat.id = 'chat';
    for (const id of ids) {
        const mes = doc.createElement('div');
        mes.className = 'mes';
        mes.setAttribute('mesid', String(id));
        mes.append(Object.assign(doc.createElement('div'), { className: 'extraMesButtons' }));
        chat.append(mes);
    }
    doc.append(chat);
    return doc;
}
