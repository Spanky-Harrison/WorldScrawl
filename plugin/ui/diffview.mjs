// Red/green before/after view for map changes, in the style of LoreReviser's "Changes" view: prose compared sentence by
// sentence, each changed run shown as a REMOVED block (red) then an ADDED block (green), labels on their own line,
// unchanged sentences dimmed. Pure helpers (splitSentences, blockDiff, fieldDiffs) run in node; renderDiff needs a DOM.

/** Sentence blocks (a newline also ends one); joined they give back the text's words. */
export function splitSentences(text) {
    const out = [];
    for (const line of String(text ?? '').split(/\n+/)) {
        const parts = line.match(/[^.!?\u2026]+(?:[.!?\u2026]+["'\u201d\u2019)\]*]*(?=\s|$)|$)/g) ?? [];
        for (const p of parts) { const t = p.trim(); if (t) out.push(t); }
    }
    return out;
}
/** Block diff (LCS): [{type: 'same'|'del'|'ins', blocks}], removed blocks before added ones in each changed run. */
export function blockDiff(oldText, newText) {
    const a = splitSentences(oldText), b = splitSentences(newText), n = a.length, m = b.length, w = m + 1;
    if (n * m > 1_000_000) return [...(n ? [{ type: 'del', blocks: a }] : []), ...(m ? [{ type: 'ins', blocks: b }] : [])];
    const t = new Int32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) t[i * w + j] = a[i] === b[j] ? t[(i + 1) * w + j + 1] + 1 : Math.max(t[(i + 1) * w + j], t[i * w + j + 1]);
    const ops = []; let i = 0, j = 0, dels = [], inss = [];
    const flush = () => { if (dels.length) ops.push({ type: 'del', blocks: dels }); if (inss.length) ops.push({ type: 'ins', blocks: inss }); dels = []; inss = []; };
    while (i < n || j < m) {
        if (i < n && j < m && a[i] === b[j]) { flush(); const l = ops.at(-1); if (l?.type === 'same') l.blocks.push(a[i]); else ops.push({ type: 'same', blocks: [a[i]] }); i++; j++; }
        else if (i < n && (j >= m || t[(i + 1) * w + j] >= t[i * w + j + 1])) dels.push(a[i++]);
        else inss.push(b[j++]);
    }
    flush();
    return ops;
}

/** Word diff (LCS on words and spaces): [{type: 'same'|'del'|'ins', text}]. Used inside a changed sentence run. */
export function wordDiff(oldText, newText) {
    const a = String(oldText ?? '').split(/(\s+)/).filter(Boolean), b = String(newText ?? '').split(/(\s+)/).filter(Boolean), n = a.length, m = b.length, w = m + 1;
    if (n * m > 400_000) return [...(n ? [{ type: 'del', text: a.join('') }] : []), ...(m ? [{ type: 'ins', text: b.join('') }] : [])];
    const t = new Int32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) t[i * w + j] = a[i] === b[j] ? t[(i + 1) * w + j + 1] + 1 : Math.max(t[(i + 1) * w + j], t[i * w + j + 1]);
    const out = [], push = (type, x) => { const l = out.at(-1); if (l?.type === type) l.text += x; else out.push({ type, text: x }); };
    let i = 0, j = 0;
    while (i < n || j < m) {
        if (i < n && j < m && a[i] === b[j]) { push('same', a[i]); i++; j++; }
        else if (i < n && (j >= m || t[(i + 1) * w + j] >= t[i * w + j + 1])) push('del', a[i++]);
        else push('ins', b[j++]);
    }
    return out;
}

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
/** An exit's door state in words. */
export function exitState(e) {
    if (!e) return '';
    const b = isObj(e.barrier) ? e.barrier : null;
    const door = !b ? 'open way' : b.openable === false ? 'blocked' : b.locked ? 'locked door' : b.starts_open ? 'open door' : 'closed door';
    return [door, e.hidden ? 'hidden' : '', e.obscured ? 'obscured' : ''].filter(Boolean).join(', ');
}
const exitLine = e => `${e.direction} → ${e.to ?? '?'}`;

/**
 * Per-place, per-field changes between before and after ({address or area: room | {name, notes, area} | null}).
 * Returns [{key, title, kind: 'room'|'area', status: 'changed'|'removed'|'added'|'same', into?, fields: [{field, label, kind: 'text'|'list', old, new, changed}]}].
 * relocate ({old: new}) turns removed rooms into "rooms X, Y → Z".
 */
export function fieldDiffs(before = {}, after = {}, relocate = {}) {
    const keys = [...new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])];
    const out = [];
    for (const key of keys) {
        const o = before?.[key] ?? null, n = after?.[key] ?? null, area = !!(o?.area || n?.area || !key.includes('/'));
        const fields = [];
        const text = (field, label) => { const a = String(o?.[field] ?? ''), b = String(n?.[field] ?? ''); if (a || b) fields.push({ field, label, kind: 'text', old: a, new: b, changed: a !== b }); };
        text('name', 'Name'); text('description', 'Description'); text('notes', 'Notes');
        if (!area) {
            const oe = (o?.exits ?? []).filter(isObj), ne = (n?.exits ?? []).filter(isObj);
            const dirs = [...new Set([...oe, ...ne].map(e => e.direction))];
            const one = e => e ? `${exitLine(e)} (${exitState(e)})${e.description ? `: ${e.description}` : ''}` : '';
            const rows = dirs.map(d => ({ a: one(oe.find(e => e.direction === d)), b: one(ne.find(e => e.direction === d)) }));
            if (rows.length) fields.push({ field: 'exits', label: 'Exits', kind: 'list', old: rows.map(r => r.a).filter(Boolean), new: rows.map(r => r.b).filter(Boolean), changed: rows.some(r => r.a !== r.b) });
        }
        const status = !o && n ? 'added' : o && !n ? 'removed' : fields.some(f => f.changed) ? 'changed' : 'same';
        out.push({ key, title: n?.name ?? o?.name ?? key, kind: area ? 'area' : 'room', status, into: status === 'removed' ? relocate?.[key] ?? null : null, fields });
    }
    return out;
}
/** Merged rooms as one line each: "rooms A, B → C". */
export function mergeLines(diffs) {
    const by = new Map();
    for (const d of diffs) if (d.status === 'removed' && d.into) by.set(d.into, [...(by.get(d.into) ?? []), d.title]);
    return [...by].map(([into, from]) => { const t = diffs.find(d => d.key === into)?.title ?? into; return `rooms ${from.join(', ')} → ${t}`; });
}

const CSS = `
.wsdiff{font-size:0.92em;margin:4px 0;}
.wsdiff-wdel{background:rgba(220,60,60,0.45);text-decoration:line-through;border-radius:2px;}
.wsdiff-wins{background:rgba(60,180,80,0.45);border-radius:2px;}
.wsdiff-place{margin:6px 0;padding:4px 6px;border:1px solid var(--SmartThemeBorderColor,#555);border-radius:6px;}
.wsdiff-title{font-weight:bold;margin-bottom:2px;}
.wsdiff-tag{font-size:0.75em;opacity:0.7;font-weight:normal;margin-left:6px;}
.wsdiff-label{font-size:0.8em;opacity:0.75;margin-top:4px;}
.wsdiff-text{white-space:normal;padding:4px 6px;border-radius:6px;background:rgba(0,0,0,0.2);line-height:1.45;color:var(--SmartThemeBodyColor,inherit);}
.wsdiff-blk{padding:3px 8px;margin:3px 0;border-radius:4px;white-space:pre-wrap;}
.wsdiff-same{opacity:0.6;}
.wsdiff-del{background:rgba(200,60,60,0.22);border-left:3px solid #c84040;}
.wsdiff-ins{background:rgba(60,160,90,0.25);border-left:3px solid #3c9a55;}
.wsdiff-del::before,.wsdiff-ins::before{content:attr(data-mark);display:block;font-size:0.7em;font-weight:bold;opacity:0.7;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:2px;}
.wsdiff-toggle{cursor:pointer;font-size:0.8em;opacity:0.75;text-decoration:underline;margin-right:10px;}
.wsdiff-raw{max-height:240px;overflow:auto;font-size:0.85em;white-space:pre-wrap;}
.wsdiff-merge{font-weight:bold;}
`;
function ensureCss(doc) {
    if (doc.getElementById('wsdiff-css')) return;
    const st = doc.createElement('style'); st.id = 'wsdiff-css'; st.textContent = CSS; (doc.head ?? doc.documentElement).append(st);
}

/** The red/green view. opts: {before, after, ops, relocate}. Unchanged fields hidden behind a toggle; "Raw JSON" toggle. */
export function renderDiff(doc, { before = {}, after = {}, ops = [], relocate = {} } = {}) {
    ensureCss(doc);
    const mk = (tag, cls, text) => { const e = doc.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
    const root = mk('div', 'wsdiff');
    const diffs = fieldDiffs(before, after, relocate);
    let showSame = false, showRaw = false;
    const body = mk('div'), bar = mk('div');
    const blk = (type, text) => { const e = mk('div', `wsdiff-blk wsdiff-${type}`, text); if (type !== 'same') e.setAttribute('data-mark', type === 'del' ? 'Removed' : 'Added'); return e; };
    const textDiff = f => {
        const box = mk('div', 'wsdiff-text');
        if (!f.changed) { box.append(blk('same', f.new || '(empty)')); return box; }
        const ops = blockDiff(f.old, f.new);
        ops.forEach((op, k) => {
            // A removed run followed by an added one: mark the changed words inside each (red struck / green).
            const pair = op.type === 'del' && ops[k + 1]?.type === 'ins' ? ops[k + 1] : op.type === 'ins' && ops[k - 1]?.type === 'del' ? ops[k - 1] : null;
            if (!pair) { box.append(blk(op.type, op.blocks.join('\n'))); return; }
            const e = blk(op.type, '');
            const [o, nw] = op.type === 'del' ? [op, pair] : [pair, op];
            for (const p of wordDiff(o.blocks.join('\n'), nw.blocks.join('\n'))) {
                if (p.type !== 'same' && p.type !== op.type) continue;
                e.append(p.type === 'same' ? doc.createTextNode(p.text) : mk('span', `wsdiff-w${p.type}`, p.text));
            }
            box.append(e);
        });
        return box;
    };
    const listDiff = f => {
        const box = mk('div', 'wsdiff-text');
        const gone = f.old.filter(x => !f.new.includes(x)), added = f.new.filter(x => !f.old.includes(x)), kept = f.new.filter(x => f.old.includes(x));
        if (gone.length) box.append(blk('del', gone.join('\n')));
        if (added.length) box.append(blk('ins', added.join('\n')));
        if (kept.length && (showSame || !f.changed)) box.append(blk('same', kept.join('\n')));
        return box;
    };
    function draw() {
        body.replaceChildren();
        for (const line of mergeLines(diffs)) body.append(mk('div', 'wsdiff-merge', `Merge: ${line}`));
        for (const d of diffs) {
            if (d.status === 'same' && !showSame) continue;
            const place = mk('div', 'wsdiff-place');
            place.setAttribute('data-key', d.key);
            const title = mk('div', 'wsdiff-title', d.title);
            title.append(mk('span', 'wsdiff-tag', `${d.kind === 'area' ? 'area' : 'place'} · ${d.status === 'removed' ? (d.into ? `merged into ${d.into}` : 'removed') : d.status === 'added' ? 'new' : d.status}`));
            place.append(title);
            if (d.status === 'removed') { place.append(blk('del', d.fields.find(f => f.field === 'description')?.old || d.title)); body.append(place); continue; }
            for (const f of d.fields) {
                if (!f.changed && !showSame) continue;
                place.append(mk('div', 'wsdiff-label', `${f.label}${f.changed ? '' : ' (unchanged)'}`), f.kind === 'list' ? listDiff(f) : textDiff(f));
            }
            body.append(place);
        }
        if (!body.childNodes.length) body.append(mk('div', 'wsdiff-same', 'Nothing visible changes.'));
        if (showRaw) {
            const pre = mk('pre', 'wsdiff-raw');
            pre.textContent = `BEFORE\n${JSON.stringify(before ?? {}, null, 1)}\n\nAFTER\n${JSON.stringify(after ?? {}, null, 1)}\n\nOPS\n${JSON.stringify(ops ?? [], null, 1)}`;
            body.append(pre);
        }
        bar.replaceChildren(tog(showSame ? 'Hide unchanged' : 'Show unchanged', () => { showSame = !showSame; draw(); }), tog(showRaw ? 'Hide raw JSON' : 'Raw JSON', () => { showRaw = !showRaw; draw(); }));
    }
    const tog = (label, on) => { const a = mk('span', 'wsdiff-toggle', label); a.addEventListener('click', e => { e.stopPropagation(); on(); }); return a; };
    root.append(body, bar);
    draw();
    return root;
}
