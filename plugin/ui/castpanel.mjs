// The Cast panel in the map window's side pane (phase 1.5): browse worlds/<world>/cast/ and the people created in this chat,
// filter them, see where they are and what changed in play, and edit cast files. Places are always picked on the map.
// io: { load() -> GET /cast, outline() -> POST /edit/outline, save(npc, original, originalFile), del({id, file}),
//       play() -> this chat's npcs (map state) or null, placeName(a), showPlace(a), showMessage(i), exportNpc(id, update), changed(),
//       inspect() -> map state's npc_inspect {who, narrator, unsaved, threshold}, chatAt() -> {msg, swipe} of the latest message, chatEdit(id, stamps, at) -> {ok, error}, highlight(addresses) }
import { castRows, filterRows, formFromRecord, recordFromForm, formProblems, slugFor, playSummary, stampRows, DISPOSITIONS, IMPORTANCE, recordChanges, formFromPlay, chatStamps, chatStampLines, whyRows } from './castdata.mjs';
import { pickField, pathOf } from './picker.mjs';
import { groupEntries, renderEntry } from './activitylog.mjs';

export function castPanel(doc, io) {
    const $ = (tag, attrs = {}, ...kids) => { const e = doc.createElement(tag); for (const [k, v] of Object.entries(attrs)) { if (k === 'class') e.className = v; else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else if (v !== false && v !== null && v !== undefined) e.setAttribute(k, v === true ? '' : v); } e.append(...kids.flat().filter(x => x !== null && x !== undefined && x !== false)); return e; };
    let data = null, outline = null, rows = [], selKey = null, tab = 'summary', editing = null, view = 'people', narrSel = null, actSel = null;
    const filt = { q: '', place: '', status: '', disposition: '' };
    const root = $('div', { class: 'castpanel' });
    const msg = $('div', { class: 'cast-msg muted' });
    const q = $('input', { type: 'search', class: 'cast-q', placeholder: 'Search the cast…', autocomplete: 'off', oninput: () => { filt.q = q.value; drawList(); } });
    const status = $('select', { class: 'cast-status', onchange: () => { filt.status = status.value; drawList(); } },
        $('option', { value: '' }, 'Any status'), $('option', { value: 'cast' }, 'Cast file'), $('option', { value: 'play' }, 'Created in play'), $('option', { value: 'broken' }, 'Broken'));
    const disp = $('select', { class: 'cast-disp', onchange: () => { filt.disposition = disp.value; drawList(); } },
        $('option', { value: '' }, 'Any disposition'), ...['unknown', ...DISPOSITIONS].map(d => $('option', { value: d }, d)));
    const placeBox = $('span', { class: 'cast-place' });
    const list = $('ul', { class: 'cast-list' });
    const detail = $('div', { class: 'cast-detail' });
    const who = $('div', { class: 'cast-who' });
    const peopleBox = $('div', { class: 'cast-people' });
    const viewBox = $('div', { class: 'cast-view' });
    const VIEWS = [['people', 'People'], ['narrator', 'What the narrator was told'], ['unsaved', 'Not saved yet'], ['activity', 'Activity log']];
    const viewBar = $('div', { class: 'tabs cast-views' });
    const drawViews = () => viewBar.replaceChildren(...VIEWS.map(([k, l]) => $('button', { type: 'button', class: `tab${k === view ? ' active' : ''}`, 'data-view': k, onclick: () => { view = k; drawViews(); drawView(); } }, l)));
    peopleBox.append($('div', { class: 'cast-filters' }, q, $('div', {}, status, ' ', disp), placeBox), who, list, detail);
    root.append($('div', { class: 'cast-head' }, $('h3', {}, 'Cast'), $('button', { type: 'button', class: 'crumb cast-new', onclick: () => { view = 'people'; drawViews(); drawView(); startEdit(null); } }, 'New person')),
        viewBar, msg, peopleBox, viewBox);
    drawViews();
    const say = (t, bad = false) => { msg.textContent = t ?? ''; msg.classList.toggle('bad', bad); };
    const placeName = a => io.placeName?.(a) ?? pathOf(outline, 'room', a) ?? a;
    function placeFilterField() {
        const f = pickField(doc, { kind: 'room', title: 'place to filter by', outline, value: filt.place, clearable: true, empty: 'Any place' });
        f.classList.add('cast-placefilter');
        f.addEventListener('change', () => { filt.place = f.value; drawList(); });
        placeBox.replaceChildren($('span', { class: 'muted' }, 'Place: '), f);
    }
    function drawView() {
        peopleBox.hidden = view !== 'people'; viewBox.hidden = view === 'people';
        if (view === 'narrator') drawNarrator();
        if (view === 'unsaved') drawUnsaved();
        if (view === 'activity') drawActivity();
    }
    function drawActivity() {
        const msgs = io.activity?.() ?? [];
        if (!msgs.length) { viewBox.replaceChildren($('p', { class: 'muted' }, 'Open a chat to see what happened on each message.')); return; }
        const m = msgs.find(x => x.msg === actSel) ?? msgs[0];
        const sel = $('select', { class: 'pf-input cast-actsel', onchange: () => { actSel = Number(sel.value); drawActivity(); } },
            ...msgs.map(x => $('option', { value: x.msg }, `#${x.msg} ${x.who}${x === msgs[0] ? ' (latest)' : ''}${x.entries.length ? ` · ${x.entries.length}` : ''}`)));
        sel.value = String(m.msg);
        const groups = groupEntries(m.entries);
        viewBox.replaceChildren($('p', { class: 'muted' }, 'What the engine and the narrator did on this message, read from the chat, including the outcome of each model call.'), sel,
            $('button', { type: 'button', class: 'linkish cast-msglink', onclick: () => io.showMessage?.(m.msg) }, ` show #${m.msg}`),
            $('p', { class: 'muted' }, m.snippet),
            groups.length ? $('div', { class: 'cast-activity' }, ...groups.map(g => $('div', { class: 'cast-actgroup', 'data-kind': g.kind }, $('b', {}, g.title), $('ul', {}, ...g.entries.map(e => $('li', {}, renderEntry(e, $)))))))
                : $('p', { class: 'muted' }, 'Nothing recorded on this message.'));
    }
    const insp = () => io.inspect?.() ?? null;
    function drawWho() {
        const list = filt.place ? insp()?.who?.[filt.place] : null;
        if (!filt.place) { who.replaceChildren(); return; }
        who.replaceChildren($('b', {}, `Who's here: ${placeName(filt.place)}`), !list ? $('p', { class: 'muted' }, 'Open a chat to see who is here right now.')
            : !list.length ? $('p', { class: 'muted' }, 'Nobody is due here, and no schedule or sighting points here.')
                : $('ul', { class: 'cast-wholist' }, ...list.map(x => $('li', { class: x.here ? 'here' : 'away', 'data-id': x.id },
                    $('button', { type: 'button', class: 'linkish', onclick: () => api.selectId(x.id, 'play') }, x.name), ' ',
                    $('span', { class: `cast-badge ${x.here ? 'here' : 'away'}` }, x.here ? (x.inScene ? 'here, in your scene' : 'here') : 'not here'),
                    x.activity ? ` ${x.activity}` : '', $('div', { class: 'muted' }, x.reason)))));
    }
    function drawNarrator() {
        const views = insp()?.narrator ?? [];
        if (!views.length) { viewBox.replaceChildren($('p', { class: 'muted' }, 'No replies with a scene yet. Open a chat and play a turn.')); return; }
        const v = views.find(x => x.reply === narrSel) ?? views[0];
        const sel = $('select', { class: 'pf-input cast-narrsel', onchange: () => { narrSel = Number(sel.value); drawNarrator(); } }, ...views.map(x => $('option', { value: x.reply }, `Reply #${x.reply}${x === views[0] ? ' (latest)' : ''}`)));
        sel.value = String(v.reply);
        const block = (label, text) => [$('b', {}, label), $('pre', { class: 'raw cast-slice' }, text || '(empty)')];
        viewBox.replaceChildren($('p', { class: 'muted' }, 'Recomputed from the chat: what {{npcs_present}} and {{npc_focus}} held when this reply was written.'), sel,
            $('button', { type: 'button', class: 'linkish cast-msglink', onclick: () => io.showMessage?.(v.reply) }, ` show #${v.reply}`),
            v.error ? $('p', { class: 'bad' }, v.error) : $('div', {},
                $('table', { class: 'resolved cast-listed' }, $('tr', {}, $('th', {}, 'Person'), $('th', {}, 'Tier'), $('th', {}, 'Name'), $('th', {}, 'Detail'), $('th', {}, 'Memories included')),
                    ...(v.listed.length ? v.listed.map(x => $('tr', { 'data-id': x.id }, $('td', {}, x.shownAs && x.shownAs !== x.name ? `${x.shownAs} (${x.name})` : x.name),
                        $('td', { class: 'cast-tier' }, `${x.tier}: ${x.why}${x.topical ? `; + history (${x.topical})` : ''}`),
                        $('td', { class: 'cast-name' }, x.nameWhy), $('td', {}, x.depth), $('td', {}, x.memories.length ? x.memories.join('; ') : '—'))) : [$('tr', {}, $('td', { colspan: 5, class: 'muted' }, 'Nobody was listed.'))])),
                $('p', { class: 'muted' }, v.focus?.id ? `Focus: ${v.focus.id} (${v.focus.depth}${v.focus.stored ? ', from the stored focus' : ', from the focus rules'})` : 'No focus: nobody was named or addressed.'),
                ...block('{{npcs_present}}', v.npcs_present), ...block('{{npc_focus}}', v.npc_focus)));
    }
    function drawUnsaved() {
        const i = insp(), rowsU = i?.unsaved ?? [];
        viewBox.replaceChildren($('p', { class: 'muted' }, `People the narrator flagged in this scene that nobody has saved. A Remember card is offered after ${i?.threshold ?? 3} replies.`),
            !rowsU.length ? $('p', { class: 'muted' }, i ? 'Nobody unsaved is being tracked.' : 'Open a chat to see this.')
                : $('table', { class: 'resolved cast-unsaved' }, $('tr', {}, $('th', {}, 'Name'), $('th', {}, 'Replies'), $('th', {}, 'Status')),
                    ...rowsU.map(x => $('tr', {}, $('td', {}, x.name), $('td', {}, `${x.count} / ${x.threshold}`),
                        $('td', {}, x.declined ? 'a "no" was said for them in this scene' : x.card ? `Remember card: ${x.card || 'offered'}` : x.ready ? 'ready for a Remember card' : 'counting')))));
    }
    function drawList() {
        drawWho();
        const shown = filterRows(rows, filt);
        list.replaceChildren(...shown.map(r => $('li', { class: `cast-row ${r.status}${r.key === selKey ? ' selected' : ''}`, 'data-id': r.id, 'data-key': r.key, 'data-status': r.status, onclick: () => select(r.key) },
            $('b', {}, r.name), ' ', $('span', { class: `cast-badge ${r.status}` }, r.status === 'cast' ? 'cast' : r.status === 'play' ? 'in play' : 'broken'),
            r.play?.present ? $('span', { class: 'cast-badge here' }, 'here') : null,
            $('div', { class: 'muted' }, r.line.length > 90 ? `${r.line.slice(0, 89)}…` : r.line))));
        if (!shown.length) list.append($('li', { class: 'muted' }, rows.length ? 'Nobody matches.' : 'No cast yet. New person adds one.'));
    }
    const row = () => rows.find(r => r.key === selKey) ?? null;
    function select(key, t = null) {
        selKey = key; editing = null; tab = t ?? (tab === 'edit' ? 'summary' : tab === 'chatedit' ? 'play' : tab);
        drawList(); drawDetail();
        const r = row(), at = r?.play?.position?.place ?? r?.places?.[0];
        if (at) io.showPlace?.(at);
        io.highlight?.([...new Set([r?.play?.position?.place, ...(r?.places ?? [])].filter(Boolean))], r?.play?.position?.place ?? null);
    }
    const kv = pairs => $('table', { class: 'resolved' }, ...pairs.map(([k, v]) => $('tr', {}, $('th', {}, k), $('td', {}, v))));
    function drawDetail() {
        const r = row();
        if (editing) return;
        if (!r) { detail.replaceChildren($('p', { class: 'muted' }, 'Pick someone to see them. Click a place on the map to see who is there.')); return; }
        if (!tabsOf(r).some(([k]) => k === tab)) tab = 'summary';
        const bar = tabBar(r, tab);
        const pane = $('div', { class: `tabpane cast-${tab}` });
        if (tab === 'edit') return startEdit(r);
        if (tab === 'chatedit') return startEdit(r, null, 'chat');
        if (tab === 'summary') {
            const rec = r.rec?.ok ? r.rec : r.play ?? r.rec ?? {};
            const pairs = [['Id', r.id || '(none)'], ...(rec.unknownAs ? [['Known as', rec.unknownAs]] : []), ['Personality', rec.line || ''], ...(rec.manner ? [['Manner', rec.manner]] : []), ...(rec.voice ? [['Speech', rec.voice]] : []),
                ...[['Looks', rec.looks], ['Body', rec.body], ['Outfit', rec.outfit], ['History', rec.deep?.history]].filter(([, v]) => v),
                ['Starts', r.rec?.disposition?.player ? `${r.rec.disposition.player.value}${r.rec.disposition.player.reason ? ` (${r.rec.disposition.player.reason})` : ''}` : 'unknown']];
            pane.append(kv(pairs));
            const places = (r.rec?.schedule ?? []).map(e => $('li', {}, placeLink(e.place, e.broken), ` ${e.activity}${e.from || e.to ? ` ${e.from ?? ''}–${e.to ?? ''}` : ''}${e.importance ? ` · ${e.importance}` : ''}${e.broken ? ` (${e.problem})` : ''}`));
            if (r.rec?.seen_at) places.push($('li', {}, placeLink(r.rec.seen_at.place, r.rec.seen_at.broken), ` sometimes, around ${r.rec.seen_at.hour}:00 (${Math.round((r.rec.seen_at.chance ?? 0.5) * 100)}%)`));
            if (places.length) pane.append($('b', {}, 'Schedule'), $('ul', { class: 'cast-sched' }, ...places));
            if (r.problems.length) pane.append($('b', {}, 'Problems'), $('ul', { class: 'warnings' }, ...r.problems.map(p => $('li', {}, p))));
            if (r.play) pane.append($('b', {}, 'In this chat'), kv(playSummary(r.play, placeName).map(([k, v]) => [k, k === 'Where' && r.play.position?.place ? placeLink(r.play.position.place, false, v) : v])));
            const acts = $('div', { class: 'cast-acts' });
            if (r.rec) acts.append($('button', { type: 'button', class: 'crumb cast-edit', onclick: () => { tab = 'edit'; startEdit(r); } }, 'Edit'),
                $('button', { type: 'button', class: 'crumb cast-dup', onclick: () => duplicate(r) }, 'Duplicate'),
                $('button', { type: 'button', class: 'crumb cast-del', onclick: () => confirmDelete(r, acts) }, 'Delete'));
            pane.append(acts);
        }
        if (tab === 'play') pane.append(playPane(r));
        if (tab === 'raw') pane.append($('p', { class: 'muted' }, r.rec ? `cast/${r.rec.file ?? `${r.id}.json`}` : 'Not in a cast file yet (created in this chat).'),
            $('pre', { class: 'raw' }, JSON.stringify(r.rec?.raw ?? r.play?.record ?? r.rec ?? {}, null, 2)));
        detail.replaceChildren($('h3', {}, r.name), bar, pane);
    }
    const tabsOf = r => [['summary', 'Summary'], ...(r.play ? [['play', 'Under the hood']] : []), ...(r.rec ? [['edit', 'Edit: Base (cast file)']] : []), ...(r.play ? [['chatedit', 'Edit: In this chat']] : []), ['raw', 'Raw JSON']];
    const tabBar = (r, active) => $('div', { class: 'tabs' }, ...tabsOf(r).map(([k, l]) => $('button', { type: 'button', class: `tab${k === active ? ' active' : ''}`, 'data-tab': k, onclick: () => { if (k === active && editing) return; editing = null; tab = k; if (k === 'edit') startEdit(r); else if (k === 'chatedit') startEdit(r, null, 'chat'); else drawDetail(); } }, l)));
    function placeLink(a, broken = false, label = null) {
        return $('button', { type: 'button', class: `linkish cast-placelink${broken ? ' broken' : ''}`, 'data-place': a, title: broken ? 'Not in this world' : 'Show on the map', onclick: () => io.showPlace?.(a) }, label ?? placeName(a));
    }
    function playPane(r) {
        const box = $('div', {});
        const st = stampRows(r.play);
        const why = whyRows(r.play, placeName);
        if (why.length) box.append($('b', {}, 'Right now'), $('table', { class: 'resolved cast-why' }, ...why.map(([k, v]) => $('tr', { 'data-row': k }, $('th', {}, k), $('td', {}, v)))));
        box.append($('b', {}, 'Changed in this chat'));
        box.append(st.length ? $('ul', { class: 'cast-stamps' }, ...st.map(x => $('li', { class: x.off ? 'off' : '', 'data-type': x.type },
            $('button', { type: 'button', class: 'linkish cast-msglink', 'data-msg': x.msg, title: 'Show this message in SillyTavern', onclick: () => io.showMessage?.(x.msg) }, `#${x.msg}`), ' ', x.text, x.off ? ' (turned off)' : '')))
            : $('p', { class: 'muted' }, 'Nothing has changed for them in this chat.'));
        const out = $('div', { class: 'cast-export' });
        if (r.status === 'play') out.append($('button', { type: 'button', class: 'crumb cast-exportnew', onclick: () => doExport(r, false, out) }, 'Export to cast'));
        else if (r.play?.diff) {
            const d = r.play.diff;
            if (!d.changed) out.append($('p', { class: 'muted' }, 'The cast file already matches this chat.'));
            else out.append($('button', { type: 'button', class: 'crumb cast-update', onclick: () => {
                out.querySelector('.cast-diff')?.remove();
                out.append($('div', { class: 'cast-diff' }, $('ul', {}, ...d.lines.map(l => $('li', {}, $('b', {}, l.field), `: ${l.from ?? '(none)'} → ${l.to ?? '(none)'}`))),
                    $('button', { type: 'button', class: 'crumb cast-confirm', onclick: () => doExport(r, true, out) }, 'Confirm'),
                    $('button', { type: 'button', class: 'crumb', onclick: () => out.querySelector('.cast-diff')?.remove() }, 'Cancel')));
            } }, `Update ${r.name}`));
        }
        box.append(out);
        return box;
    }
    async function doExport(r, update, out) {
        out.querySelectorAll('button').forEach(b => { b.disabled = true; });
        const res = await io.exportNpc(r.id, update);
        if (!res?.ok) { say(res?.error ?? 'SillyTavern did not answer.', true); out.querySelectorAll('button').forEach(b => { b.disabled = false; }); return; }
        say(update ? `Updated cast/${res.file}.` : `Wrote cast/${res.file}.`);
        await refresh(`file:${res.file}`);
    }
    function duplicate(r) {
        const f = formFromRecord(r.rec);
        f.name = `${f.name} (copy)`; f.id = slugFor(f.id || f.name, takenIds(null));
        startEdit(null, f);
    }
    function confirmDelete(r, acts) {
        acts.querySelector('.cast-confirmdel')?.remove();
        const file = r.rec?.file ?? `${r.id}.json`;
        acts.append($('div', { class: 'cast-confirmdel' }, `Delete cast/${file}? Chats that met ${r.name} keep their changes, but the cast file is gone.`, ' ',
            $('button', { type: 'button', class: 'crumb cast-delyes', onclick: async () => {
                try { await io.del(r.rec?.ok ? { id: r.id } : { file }); } catch (e) { return say(`Delete failed: ${e.message}`, true); }
                say(`Deleted cast/${file}.`); selKey = null; await refresh();
            } }, 'Yes, delete'), $('button', { type: 'button', class: 'crumb cast-delno', onclick: ev => ev.target.closest('.cast-confirmdel').remove() }, 'No')));
    }
    const takenIds = own => new Set(rows.filter(x => x.rec && x.id && x.id !== own).map(x => x.id).concat(rows.filter(x => x.rec?.file && x.id !== own).map(x => x.rec.file.replace(/\.json$/, ''))));

    // ---- The editor.
    function startEdit(r, preset = null, mode = 'base') {
        const chatMode = mode === 'chat' && !!r?.play;
        const f = preset ?? (chatMode ? formFromPlay(r.play) : formFromRecord(r?.rec ?? null));
        const original = r?.rec?.ok ? r.id : null, originalFile = r?.rec && !r.rec.ok ? r.rec.file : null;
        const before = chatMode ? null : recordFromForm(formFromRecord(r?.rec ?? null));
        editing = { f, original, originalFile, mode: chatMode ? 'chat' : 'base', at: chatMode ? io.chatAt?.() ?? null : null };
        const ids = takenIds(original ?? (originalFile ? originalFile.replace(/\.json$/, '') : null));
        const places = new Set((data?.places ?? []));
        let idTouched = !!(original || originalFile || preset);
        const form = $('div', { class: 'castform' });
        const errs = new Map();
        const err = key => { const e = $('div', { class: 'cf-err', 'data-for': key }); errs.set(key, e); return e; };
        const fieldRow = (key, label, input, help = null) => $('div', { class: 'cf-row', 'data-field': key }, $('label', { class: 'pf-label' }, label), input, help ? $('div', { class: 'muted' }, help) : null, err(key));
        const text = (key, { area = false, ph = '' } = {}) => {
            const i = $(area ? 'textarea' : 'input', { ...(area ? { rows: 2 } : { type: 'text' }), class: 'pf-input', placeholder: ph });
            i.value = f[key] ?? '';
            i.addEventListener('input', () => { f[key] = i.value; if (key === 'name' && !idTouched) { f.id = slugFor(i.value, ids); idIn.value = f.id; } check(); });
            return i;
        };
        const lines = key => { const i = $('textarea', { rows: 3, class: 'pf-input' }); i.value = (f[key] ?? []).join('\n'); i.addEventListener('input', () => { f[key] = i.value.split('\n'); check(); }); return i; };
        const idIn = $('input', { type: 'text', class: 'pf-input', spellcheck: 'false' }); idIn.value = f.id;
        idIn.addEventListener('input', () => { idTouched = true; f.id = idIn.value; check(); });
        form.append(fieldRow('name', 'Name', text('name')), fieldRow('id', 'Id', idIn, 'The cast file name. Lowercase, like old-tam.'),
            fieldRow('unknownAs', 'Known as (before the name)', text('unknownAs', { ph: 'the landlady' }), 'What the player calls them until they learn the name. Empty: the name is used from the start.'),
            $('b', {}, 'Personality'),
            fieldRow('line', 'Summary', text('line', { ph: 'stern, watchful, sharp-tongued' }), 'Always fed while they are here.'),
            fieldRow('manner', 'Manner', text('manner', { area: true })), fieldRow('voice', 'Speech', text('voice')),
            $('b', {}, 'Appearance'),
            fieldRow('looks', 'Summary', text('looks', { ph: 'big woman with copper braids, in plain work clothes' }), 'Always fed while they are here.'),
            fieldRow('body', 'Body', text('body', { area: true, ph: 'Physical only: build, age, face, hair, marks' })),
            fieldRow('outfit', 'Outfit', text('outfit', { area: true, ph: 'What they usually wear and carry' }), 'Body, outfit, manner and speech are fed when the player looks at or deals with them.'),
            fieldRow('history', 'History', text('history', { area: true, ph: 'Their life before the game starts' }), 'Fed only when a lore request names them ([lore] Hesk).'));
        if (chatMode && r.play?.invented?.length) form.append($('p', { class: 'muted cf-invented' }, `Made up when remembered (not in the story): ${r.play.invented.join('; ')}`));
        const dsel = $('select', { class: 'pf-input' }, $('option', { value: '' }, 'unknown'), ...DISPOSITIONS.map(d => $('option', { value: d }, d)));
        dsel.value = f.disposition; dsel.addEventListener('change', () => { f.disposition = dsel.value; check(); });
        form.append(fieldRow('disposition', 'Starts toward the player', dsel), fieldRow('reason', 'Because', text('reason')));
        // Schedule: places come from the map picker only.
        const schedBox = $('div', { class: 'cf-schedule' });
        const drawSched = () => {
            schedBox.replaceChildren(...f.schedule.map((e, i) => {
                const pk = pickField(doc, { kind: 'room', title: `place for ${e.activity || 'this entry'}`, outline, value: e.place });
                pk.addEventListener('change', () => { e.place = pk.value; check(); });
                const act = $('input', { type: 'text', class: 'pf-input cf-activity', placeholder: 'doing what' }); act.value = e.activity; act.addEventListener('input', () => { e.activity = act.value; check(); });
                const tm = k => { const t = $('input', { type: 'time', class: `pf-input cf-${k}` }); t.value = e[k]; t.addEventListener('input', () => { e[k] = t.value; check(); }); t.addEventListener('change', () => { e[k] = t.value; check(); }); return t; };
                const imp = $('select', { class: 'pf-input cf-importance' }, $('option', { value: '' }, 'importance'), ...IMPORTANCE.map(x => $('option', { value: x }, x))); imp.value = e.importance; imp.addEventListener('change', () => { e.importance = imp.value; check(); });
                return $('div', { class: 'cf-sched', 'data-i': i }, $('div', { class: 'cf-schedtop' }, pk, $('button', { type: 'button', class: 'pf-x cf-schedx', title: 'Remove this entry', onclick: () => { f.schedule.splice(i, 1); drawSched(); check(); } }, '✕')),
                    err(`schedule.${i}.place`), $('div', { class: 'cf-schedrow' }, act, tm('from'), '–', tm('to'), imp),
                    err(`schedule.${i}.activity`), err(`schedule.${i}.from`), err(`schedule.${i}.to`), err(`schedule.${i}.importance`));
            }), $('button', { type: 'button', class: 'crumb cf-addsched', onclick: () => { f.schedule.push({ place: '', activity: '', from: '', to: '', importance: '' }); drawSched(); check(); } }, 'Add schedule entry'));
        };
        drawSched();
        if (!chatMode) form.append($('b', {}, 'Schedule'), $('div', { class: 'muted' }, 'Entries are checked in order; one with no times fills the rest of the day.'), schedBox);
        // Sighting: a place they are sometimes seen, at an hour, with a chance.
        const seenBox = $('div', { class: 'cf-seen' });
        const drawSeen = () => {
            const on = $('input', { type: 'checkbox', class: 'cf-seenon' }); on.checked = !!f.seen;
            on.addEventListener('change', () => { f.seen = on.checked ? { place: '', hour: 12, chance: 0.5 } : null; drawSeen(); check(); });
            seenBox.replaceChildren($('label', {}, on, ' Sometimes seen at a place'));
            if (!f.seen) return;
            const pk = pickField(doc, { kind: 'room', title: 'where they are seen', outline, value: f.seen.place });
            pk.addEventListener('change', () => { f.seen.place = pk.value; check(); });
            const hr = $('input', { type: 'number', min: 0, max: 23, step: 1, class: 'pf-input cf-hour' }); hr.value = f.seen.hour; hr.addEventListener('input', () => { f.seen.hour = hr.value; check(); });
            const ch = $('input', { type: 'number', min: 0, max: 1, step: 0.05, class: 'pf-input cf-chance' }); ch.value = f.seen.chance; ch.addEventListener('input', () => { f.seen.chance = ch.value; check(); });
            seenBox.append(pk, err('seen.place'), $('div', { class: 'cf-schedrow' }, $('span', { class: 'muted' }, 'hour'), hr, $('span', { class: 'muted' }, 'chance'), ch), err('seen.hour'), err('seen.chance'));
        };
        drawSeen();
        if (!chatMode) form.append($('b', {}, 'Sighting'), seenBox);
        // Deep tiers (shown only when the scene calls for them), facts and memory.
        const relBox = $('div', { class: 'cf-rels' });
        const drawRels = () => relBox.replaceChildren(...f.relationships.map((x, i) => {
            const w = $('input', { type: 'text', class: 'pf-input cf-relwho', placeholder: 'who' }); w.value = x.who; w.addEventListener('input', () => { x.who = w.value; check(); });
            const t = $('input', { type: 'text', class: 'pf-input cf-reltext', placeholder: 'how they stand' }); t.value = x.text; t.addEventListener('input', () => { x.text = t.value; check(); });
            return $('div', { class: 'cf-rel' }, w, t, $('button', { type: 'button', class: 'pf-x', onclick: () => { f.relationships.splice(i, 1); drawRels(); check(); } }, '✕'), err(`relationships.${i}.who`));
        }), $('button', { type: 'button', class: 'crumb', onclick: () => { f.relationships.push({ who: '', text: '' }); drawRels(); } }, 'Add relationship'));
        drawRels();
        form.append($('details', { class: 'cf-deep' }, $('summary', {}, 'Deep (secrets, relationships)'),
            fieldRow('secrets', 'Secrets (one per line)', lines('secrets')), $('b', {}, 'Relationships'), relBox),
            fieldRow('facts', 'Facts (one per line)', lines('facts')), fieldRow('memory', 'Memory highlights (one per line)', lines('memory')));
        if (chatMode) { form.querySelector('[data-field="id"]')?.remove(); form.prepend($('p', { class: 'muted cf-modenote' }, `Saves a "Character changed here" stamp on the latest message of this chat. The cast file is not touched. Schedule and sighting are edited in the base record.`)); }
        else form.prepend($('p', { class: 'muted cf-modenote' }, `Saves worldscrawl's cast/${originalFile ?? `${f.id || 'new'}.json`}. Chats keep their own changes on top.`));
        const save = $('button', { type: 'button', class: 'crumb cast-save', onclick: () => review() }, chatMode ? 'Save in this chat' : original || originalFile ? 'Save' : 'Create');
        const cancel = $('button', { type: 'button', class: 'crumb cast-cancel', onclick: () => { editing = null; tab = chatMode ? 'play' : 'summary'; drawDetail(); } }, 'Cancel');
        const raw = $('pre', { class: 'raw cf-raw' });
        const reviewBox = $('div', { class: 'cast-review' });
        form.append($('div', { class: 'cast-acts' }, save, cancel), reviewBox, ...(chatMode ? [] : [$('details', { class: 'cf-advanced' }, $('summary', {}, 'Advanced: raw JSON'), raw)]));
        /** Show the diff first; Confirm does the save. */
        function review() {
            if (Object.keys(check()).length) return;
            let lines = [], notes = [];
            if (chatMode) { const c = chatStamps(r.play, f); editing.stamps = c.stamps; lines = chatStampLines(c.stamps); notes = c.cannot.map(x => `Can't ${x}.`); }
            else lines = recordChanges(before ?? {}, recordFromForm(f)).map(x => `${x.field}: ${x.from || '(none)'} → ${x.to || '(none)'}`);
            reviewBox.replaceChildren($('div', { class: 'cast-diff' }, $('b', {}, chatMode ? 'Stamps to add in this chat' : `Changes to cast/${originalFile ?? `${recordFromForm(f).id}.json`}`),
                lines.length ? $('ul', {}, ...lines.map(l => $('li', {}, l))) : $('p', { class: 'muted' }, 'Nothing changed.'),
                notes.length ? $('ul', { class: 'warnings' }, ...notes.map(l => $('li', {}, l))) : null,
                lines.length ? $('button', { type: 'button', class: 'crumb cast-confirm', onclick: () => doSave() }, 'Confirm') : null,
                $('button', { type: 'button', class: 'crumb', onclick: () => reviewBox.replaceChildren() }, 'Back')));
        }
        function check() {
            reviewBox.replaceChildren();
            const p = formProblems(f, { places: chatMode ? null : places, ids: chatMode ? new Set() : ids });
            for (const [k, e] of errs) e.textContent = p[k] ?? '';
            form.querySelectorAll('.cf-row, .cf-sched').forEach(x => x.classList.remove('bad'));
            for (const k of Object.keys(p)) errs.get(k)?.parentElement?.classList.add('bad');
            save.disabled = Object.keys(p).length > 0;
            raw.textContent = JSON.stringify(recordFromForm(f), null, 2);
            return p;
        }
        async function doSave() {
            if (Object.keys(check()).length) return;
            save.disabled = true;
            if (chatMode) {
                const res = await io.chatEdit?.(r.id, editing.stamps ?? [], editing.at);
                if (!res?.ok) { say(`Not saved: ${res?.error ?? 'SillyTavern did not answer.'}`, true); save.disabled = false; return; }
                say(`Saved ${res.count} change${res.count === 1 ? '' : 's'} on message #${res.msg}.`); editing = null; tab = 'play'; drawDetail();
                return;
            }
            try {
                const res = await io.save(recordFromForm(f), original, originalFile);
                say(`Saved cast/${res.file}.`); editing = null; tab = 'summary';
                await refresh(`file:${res.file}`);
            } catch (e) { say(`Not saved: ${e.message}`, true); save.disabled = false; }
        }
        const title = chatMode ? `${r.name} in this chat` : original || originalFile ? `Edit ${r?.name ?? f.name}` : 'New person';
        const head = r ? tabBar(r, chatMode ? 'chatedit' : 'edit') : null;
        detail.replaceChildren($('h3', {}, title), head, $('div', { class: 'tabpane cast-edit' }, form));
        check();
    }

    async function refresh(selectKey) {
        try { data = await io.load(); } catch (e) { say(`Could not load the cast: ${e.message}`, true); return; }
        if (!outline) try { outline = await io.outline(); } catch { outline = null; }
        rows = castRows(data.npcs ?? [], io.play?.() ?? []);
        placeFilterField();
        if (selectKey !== undefined) { selKey = selectKey && rows.some(r => r.key === selectKey) ? selectKey : null; editing = null; }
        drawList(); drawDetail();
        io.changed?.();
    }
    /** New map state (a chat turn): the in-play side changes; an open editor is left alone. */
    function setPlay() {
        if (!data) return;
        rows = castRows(data.npcs ?? [], io.play?.() ?? []);
        drawList();
        if (!editing) drawDetail();
        if (view !== 'people') drawView();
    }
    /** A place clicked on the map: filter by it, and select the one person there if there is just one. */
    function selectPlace(addr) {
        filt.place = addr ?? '';
        placeFilterField();
        const shown = filterRows(rows, filt);
        if (shown.length === 1 && !editing) { selKey = shown[0].key; drawDetail(); }
        drawList();
    }
    const api = { el: root, refresh, setPlay, selectPlace, rows: () => rows, resetOutline: () => { outline = null; }, isEditing: () => !!editing, selectId: (id, t) => { const r = rows.find(x => x.id === id); if (r) select(r.key, t); }, setView: v => { view = v; drawViews(); drawView(); } };
    return api;
}
