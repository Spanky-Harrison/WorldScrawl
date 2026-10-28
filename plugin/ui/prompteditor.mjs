// Tools > Prompt Editor: edit the prompt text per profile. Default is read-only; a profile keeps only its overrides.
// Server routes: GET /prompts, POST /prompts/select|profile|override|reset (plugin/prompts.mjs).
import { placeholdersIn } from './prompts.mjs';

/** Placeholders the default text has that this text dropped (the game fills them; leaving one out loses that part). */
export const missingPlaceholders = (entry, text) => {
    const have = new Set(placeholdersIn(text));
    return (entry.placeholders ?? []).filter(p => !p.optional && !have.has(p.name)).map(p => p.name);
};
/** Placeholders in the text that the game never fills (shown as a warning). */
export const unknownPlaceholders = (entry, text) => {
    const known = new Set((entry.placeholders ?? []).map(p => p.name));
    return placeholdersIn(text).filter(n => !known.has(n));
};
/** A line diff (longest common subsequence): [{op: ' '|'-'|'+', line}]. */
export function lineDiff(a, b) {
    const A = String(a).split('\n'), B = String(b).split('\n'), n = A.length, m = B.length;
    const L = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    const out = []; let i = 0, j = 0;
    while (i < n && j < m) {
        if (A[i] === B[j]) { out.push({ op: ' ', line: A[i] }); i++; j++; }
        else if (L[i + 1][j] >= L[i][j + 1]) out.push({ op: '-', line: A[i++] });
        else out.push({ op: '+', line: B[j++] });
    }
    while (i < n) out.push({ op: '-', line: A[i++] });
    while (j < m) out.push({ op: '+', line: B[j++] });
    return out;
}

/**
 * Sort the prompts into their process groups (in the file's group order): [{group, main, pieces}]. Prompts with no known
 * group go in a last "Other" group. `piece: true` entries (small fragments filled into a bigger prompt) go in `pieces`.
 */
export function groupPrompts(prompts, groups = []) {
    const out = groups.map(g => ({ group: g, main: [], pieces: [] })), by = new Map(out.map(x => [x.group.id, x]));
    let other = null;
    for (const e of prompts) {
        let g = by.get(e.group);
        if (!g) { if (!other) other = { group: { id: 'other', title: 'Other', flow: '' }, main: [], pieces: [] }; g = other; }
        (e.piece ? g.pieces : g.main).push(e);
    }
    return [...out, ...(other ? [other] : [])].filter(x => x.main.length + x.pieces.length);
}
/** A locked prompt (the game depends on its exact wording or format) is read-only unless Debug > Unlock locked prompts is on. */
export const isLocked = (e, unlocked = false) => !!e.locked && !unlocked;

const h = (tag, attrs = {}, ...kids) => { const el = document.createElement(tag); for (const [k, v] of Object.entries(attrs)) { if (k === 'class') el.className = v; else if (k.startsWith('on')) el.addEventListener(k.slice(2), v); else if (v !== false && v != null) el.setAttribute(k, v === true ? '' : v); } el.append(...kids.flat().filter(x => x != null && x !== false)); return el; };

/**
 * Build the editor in `root`. io = {get(path), post(path, body), changed()}: changed() is called after anything is saved
 * (the map tells the SillyTavern tab to reload its prompts). ui = {ask(question, def) -> string|null, confirm(text) -> bool, unlocked() -> bool}.
 * Returns {onClose, refresh}: call refresh() when the unlock setting changes.
 */
export function promptEditor(root, io, ui = {}) {
    ui = { ask: (q, d) => prompt(q, d), confirm: t => confirm(t), unlocked: () => false, ...ui };
    let st = null, dirty = new Map(); // id -> unsaved text
    const opened = new Set(); // group ids (and 'pieces:<group id>') the user opened; everything starts collapsed
    const status = h('span', { class: 'pe-status', role: 'status' });
    const say = t => { status.textContent = t; };
    const head = h('div', { class: 'pe-profiles' }), list = h('div', { class: 'pe-list' });
    const search = h('input', { type: 'search', class: 'pe-search', placeholder: 'Find a prompt…', oninput: () => draw() });
    root.append(h('div', { class: 'pe' }, head, h('div', { class: 'pe-tools' }, search, status), list));
    const readOnly = () => !st || st.selected === st.default_profile;
    const ov = id => st.profiles[st.selected]?.overrides?.[id];
    const savedText = e => ov(e.id)?.text ?? e.text;
    const act = async (path, body, msg) => {
        try { st = await io.post(path, body); dirty.clear(); draw(); say(msg); io.changed(); return true; }
        catch (e) { say(`Couldn't do that: ${e.message}`); return false; }
    };
    const askName = (q, d = '') => { const n = ui.ask(q, d); return n == null ? null : n.trim() || null; };
    const newProfile = async (from = null) => {
        const name = askName(from ? `Name for the copy of "${from}":` : 'Name for the new profile:', from ? `${from} copy` : 'My prompts');
        if (!name) return false;
        return act('/prompts/profile', from ? { action: 'duplicate', from, name } : { action: 'new', name }, `Made profile "${name}"; it is now in use.`);
    };
    function drawHead() {
        const sel = h('select', { class: 'pe-profile', 'aria-label': 'Profile', onchange: async () => {
            if (dirty.size && !ui.confirm('You have unsaved edits. Switch profile and lose them?')) { sel.value = st.selected; return; }
            await act('/prompts/select', { profile: sel.value }, `Now using "${sel.value}".`);
        } }, [st.default_profile, ...Object.keys(st.profiles)].map(n => h('option', { value: n, ...(n === st.selected ? { selected: true } : {}) }, n === st.default_profile ? `${n} (read-only)` : n)));
        const ro = readOnly();
        head.replaceChildren(h('label', {}, 'Profile in use: ', sel),
            h('button', { type: 'button', class: 'crumb pe-new', onclick: () => newProfile() }, 'New'),
            h('button', { type: 'button', class: 'crumb pe-dup', onclick: () => newProfile(st.selected) }, 'Duplicate'),
            h('button', { type: 'button', class: 'crumb pe-rename', disabled: ro, onclick: () => { const n = askName(`New name for "${st.selected}":`, st.selected); if (n && n !== st.selected) act('/prompts/profile', { action: 'rename', from: st.selected, name: n }, `Renamed to "${n}".`); } }, 'Rename'),
            h('button', { type: 'button', class: 'crumb pe-delete', disabled: ro, onclick: () => { if (ui.confirm(`Delete the profile "${st.selected}"? Its edits are lost. The Default prompts are used again.`)) act('/prompts/profile', { action: 'delete', name: st.selected }, 'Profile deleted; using Default.'); } }, 'Delete'),
            ro ? h('span', { class: 'pe-ro-note' }, 'Default is read-only. Start editing and you will be asked to make a profile.') : null);
    }
    function card(e) {
        const locked = isLocked(e, ui.unlocked());
        const o = ov(e.id), text = dirty.has(e.id) ? dirty.get(e.id) : savedText(e);
        const ta = h('textarea', { class: 'pe-text', spellcheck: 'false', 'aria-label': e.title, rows: Math.min(18, Math.max(2, text.split('\n').length + 1)), readonly: locked });
        ta.value = text;
        const warn = h('div', { class: 'pe-warn' });
        const showWarn = () => {
            const miss = missingPlaceholders(e, ta.value), unk = unknownPlaceholders(e, ta.value);
            warn.textContent = [miss.length ? `Missing: ${miss.map(n => `{{${n}}}`).join(', ')} (the game fills these in; without them that part is lost)` : '',
                unk.length ? `Not filled by the game: ${unk.map(n => `{{${n}}}`).join(', ')}` : ''].filter(Boolean).join(' · ');
        };
        const sub = h('button', { type: 'button', class: 'crumb pe-submit', onclick: async () => {
            const miss = missingPlaceholders(e, ta.value);
            if (miss.length && !ui.confirm(`This text no longer has ${miss.map(n => `{{${n}}}`).join(', ')}. The game fills ${miss.length > 1 ? 'these' : 'this'} in, so that part will be missing from the prompt. Save anyway?`)) return;
            await act('/prompts/override', { profile: st.selected, id: e.id, text: ta.value }, `Saved "${e.title}".`);
        } }, 'Submit');
        const undo = h('button', { type: 'button', class: 'crumb pe-undo', title: 'Go back to the last saved text', onclick: () => { dirty.delete(e.id); draw(); } }, 'Undo edits');
        const reset = h('button', { type: 'button', class: 'crumb pe-reset', title: 'Remove this edit; use the default text', disabled: !o,
            onclick: () => { if (ui.confirm(`Reset "${e.title}" to the default text?`)) act('/prompts/reset', { profile: st.selected, id: e.id }, `"${e.title}" uses the default again.`); } }, 'Reset to default');
        const sync = () => { const d = dirty.has(e.id); sub.disabled = !d || locked; undo.disabled = !d; el.classList.toggle('dirty', d); };
        ta.addEventListener('focus', async () => {
            if (locked || !readOnly()) return;
            ta.blur();
            if (ui.confirm('Default is read-only. Make a new profile to edit the prompts?')) await newProfile();
        });
        ta.addEventListener('input', () => { if (ta.value === savedText(e)) dirty.delete(e.id); else dirty.set(e.id, ta.value); showWarn(); sync(); });
        const ph = (e.placeholders ?? []).map(p => h('code', { class: `pe-ph${p.generated ? ' generated' : ''}`, title: p.generated ? 'Made by the game (read-only)' : 'Filled in by the game' }, `{{${p.name}}}`));
        const badge = o?.default_changed ? h('details', { class: 'pe-changed' }, h('summary', {}, '⚠ Default changed since you edited this'),
            h('pre', { class: 'pe-diff' }, lineDiff(o.base_text ?? '', e.text).map(d => h('span', { class: d.op === '+' ? 'add' : d.op === '-' ? 'del' : '' }, `${d.op} ${d.line}\n`)))) : null;
        const el = h('article', { class: `pe-card${e.locked ? ' locked' : ''}${locked ? ' readonly' : ''}`, 'data-id': e.id },
            h('div', { class: 'pe-card-head' }, e.locked ? h('span', { class: 'pe-lock', title: locked ? 'Locked' : 'Unlocked (Debug menu)' }, locked ? '🔒' : '🔓') : null, h('b', {}, e.title), o ? h('span', { class: 'pe-overridden', title: 'This profile changes this prompt' }, '● edited') : null, h('code', { class: 'pe-id' }, e.id)),
            e.description ? h('div', { class: 'pe-desc' }, e.description) : null,
            e.locked ? h('div', { class: 'pe-locked' }, locked ? `Locked: ${e.locked} Turn on Debug > Unlock locked prompts to edit it.` : `Unlocked (normally locked): ${e.locked} Edit with care.`) : null, badge,
            ta, warn, ph.length ? h('div', { class: 'pe-phs' }, 'Placeholders: ', ph) : null,
            h('div', { class: 'pe-buttons' }, sub, undo, reset));
        sync(); showWarn();
        return el;
    }
    function draw() {
        if (!st) return;
        drawHead();
        const q = search.value.trim().toLowerCase();
        const hits = st.prompts.filter(e => !q || `${e.id} ${e.title} ${e.description} ${savedText(e)}`.toLowerCase().includes(q));
        const section = (key, cls, summary, kids) => { // collapsed unless opened (or searching); remembers what you opened
            const d = h('details', { class: cls, 'data-group': key, ...(q || opened.has(key) ? { open: true } : {}) }, h('summary', {}, summary), kids);
            d.addEventListener('toggle', () => { if (q) return; if (d.open) opened.add(key); else opened.delete(key); });
            return d;
        };
        list.replaceChildren(...groupPrompts(hits, st.groups).map(({ group: g, main, pieces }) => {
            const all = [...main, ...pieces], edited = all.filter(e => ov(e.id)).length;
            return section(g.id, 'pe-group', [h('span', { class: 'pe-group-title' }, g.title),
                h('span', { class: 'pe-count' }, `${all.length} prompt${all.length === 1 ? '' : 's'}`),
                edited ? h('span', { class: 'pe-edited-count' }, `${edited} edited`) : null], [
                g.flow ? h('p', { class: 'pe-flow' }, g.flow) : null, ...main.map(card),
                pieces.length ? section(`pieces:${g.id}`, 'pe-pieces', `Pieces (${pieces.length}): small parts filled into the prompts above`, pieces.map(card)) : null]);
        }));
    }
    io.get('/prompts').then(s => { st = s; draw(); }).catch(e => say(`Couldn't load the prompts: ${e.message}`));
    return { onClose: () => !dirty.size || ui.confirm('You have unsaved edits. Close and lose them?'), refresh: () => draw() };
}
