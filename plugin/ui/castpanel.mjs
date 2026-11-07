// The Cast panel in the map window's side pane: browse worlds/<world>/cast/ and the people created in this chat,
// filter them, see where they are and what changed in play. The open person uses the same tabs as the place inspector.
// One Edit button stamps this chat. Update, Save as new and New person write a cast file from an authoring form
// seeded with the base plus lasting changes (not a temporary transformation). Places are always picked on the map.
// io: { load() -> GET /cast, outline() -> POST /edit/outline, save(npc, original, originalFile), del({id, file}),
//       play() -> this chat's npcs (map state) or null, placeName(a), showPlace(a), showMessage(i), exportNpc(id, update), changed(),
//       inspect() -> map state's npc_inspect {who, narrator, unsaved, threshold}, chatAt() -> {msg, swipe} of the latest message, chatEdit(id, stamps, at) -> {ok, error}, highlight(addresses) }
import { permanentProblem, liveSchedule } from './castdata.mjs';
import { castRows, filterRows, formFromRecord, recordFromForm, formProblems, slugFor, playSummary, stampRows, DISPOSITIONS, IMPORTANCE, recordChanges, chatStamps, chatStampLines, whyRows, activeFounds, permanentSchedule, cardAppearance, resolvedCard, editSeed, authoringChanges } from './castdata.mjs';
import { pickField, pathOf } from './picker.mjs';

export function castPanel(doc, io) {
    const $ = (tag, attrs = {}, ...kids) => { const e = doc.createElement(tag); for (const [k, v] of Object.entries(attrs)) { if (k === 'class') e.className = v; else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else if (v !== false && v !== null && v !== undefined) e.setAttribute(k, v === true ? '' : v); } e.append(...kids.flat().filter(x => x !== null && x !== undefined && x !== false)); return e; };
    let data = null, outline = null, rows = [], selKey = null, tab = 'resolved', editing = null, view = 'people', narrSel = null;
    const drafts = new Map(); // personKey:mode -> {f, seed, el}. Closing a tab keeps the draft; Cancel drops it.
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
    const VIEWS = [['people', 'People'], ['offmap', 'Off the map'], ['narrator', 'What the narrator was told'], ['unsaved', 'Not saved yet']];
    const viewBar = $('div', { class: 'tabs cast-views' });
    const drawViews = () => viewBar.replaceChildren(...VIEWS.map(([k, l]) => $('button', { type: 'button', class: `tab${k === view ? ' active' : ''}`, 'data-view': k, onclick: () => { view = k; drawViews(); drawView(); } }, l)));
    peopleBox.append($('div', { class: 'cast-filters' }, q, $('div', {}, status, ' ', disp), placeBox), who, list, detail);
    root.append($('div', { class: 'cast-head' }, $('h3', {}, 'Cast'), $('button', { type: 'button', class: 'crumb cast-new', title: 'Write a new cast file. This does not stamp the chat.', onclick: () => { view = 'people'; drawViews(); drawView(); openDraft(null, 'new'); } }, 'New person')),
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
        if (view === 'offmap') drawOffmap();
        if (view === 'narrator') drawNarrator();
        if (view === 'unsaved') drawUnsaved();
    }
    function drawOffmap() {
        const report = insp()?.offmap;
        const stubs = report?.stubs ?? data?.elsewhere ?? [];
        if (!stubs.length && !report?.people?.length) { viewBox.replaceChildren($('p', { class: 'muted' }, 'This world has no stub regions, and nobody is off the map.')); return; }
        const whoLine = p => (p.activity || 'away') + (p.where ? ' (' + p.where + ')' : '');
        const jump = (id, name) => $('button', { type: 'button', class: 'linkish', onclick: () => api.selectId(id, 'state') }, name);
        const kids = [$('p', { class: 'muted' }, 'Stub regions are places in the fiction that are not on the map yet. A real region with the same id takes over, and nothing is rewritten.')];
        for (const s of stubs) {
            const who = s.who?.length ? s.who.map(w => $('li', { 'data-id': w.id }, jump(w.id, w.name), ' — ' + whoLine(w))) : [$('li', { class: 'muted' }, 'Nobody is off in here right now.')];
            kids.push($('div', { class: 'cast-stub', 'data-stub': s.id }, $('b', {}, s.name), s.shadowed ? ' (on the map now)' : '', $('div', { class: 'muted' }, s.about || ''), s.lore ? $('div', { class: 'muted' }, 'Lore on file (ask with [lore]).') : null, $('ul', {}, ...who)));
        }
        const others = (report?.people ?? []).filter(p => p.near?.kind !== 'stub');
        if (others.length) kids.push($('div', {}, $('b', {}, 'Off the map, not in a stub'), $('ul', {}, ...others.map(p => $('li', { 'data-id': p.id }, jump(p.id, p.name), ' — ' + whoLine(p), $('div', { class: 'muted' }, p.how || ''))))));
        if (report?.found?.length) kids.push($('div', {}, $('b', {}, 'Found flags'), $('ul', { class: 'cast-foundflags' }, ...report.found.map(f => $('li', { class: f.ok ? 'ok' : 'bad', 'data-id': f.id }, (f.name || '') + ': ' + (f.ok ? 'accepted' : 'rejected') + (f.source ? ' (' + f.source + ')' : '') + ' — ' + (f.reason || ''))))));
        viewBox.replaceChildren(...kids);
    }
    const insp = () => io.inspect?.() ?? null;
    function drawWho() {
        const list = filt.place ? insp()?.who?.[filt.place] : null;
        if (!filt.place) { who.replaceChildren(); return; }
        who.replaceChildren($('b', {}, `Who's here: ${placeName(filt.place)}`), !list ? $('p', { class: 'muted' }, 'Open a chat to see who is here right now.')
            : !list.length ? $('p', { class: 'muted' }, 'Nobody is due here, and no schedule or sighting points here.')
                : $('ul', { class: 'cast-wholist' }, ...list.map(x => $('li', { class: x.here ? 'here' : 'away', 'data-id': x.id },
                    $('button', { type: 'button', class: 'linkish', onclick: () => api.selectId(x.id, 'state') }, x.name), ' ',
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
                ...block('Came and went since the last reply (sent with {{npcs_present}})', (v.comings ?? []).join('\n') || '(nobody)'),
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
    const TABS = ['resolved', 'raw', 'state', 'warnings', 'changes'];
    const liveChat = () => { const at = io.chatAt?.(); return !!(at && at.msg >= 0); };
    function select(key, t = null) {
        selKey = key; editing = null;
        if (t && TABS.includes(t)) tab = t;
        drawList(); drawDetail();
        const r = row(), at = r?.play?.position?.place ?? r?.places?.[0];
        if (at) io.showPlace?.(at);
        io.highlight?.([...new Set([r?.play?.position?.place, ...(r?.places ?? [])].filter(Boolean))], r?.play?.position?.place ?? null);
    }
    function tabLabel(r, k) {
        if (k === 'warnings') return `Warnings${r.problems?.length ? ` (${r.problems.length})` : ''}`;
        if (k === 'changes') { const n = r.play ? stampRows(r.play).length : 0; return `Changes${n ? ` (${n})` : ''}`; }
        return { resolved: 'Resolved', raw: 'Raw', state: 'State' }[k];
    }
    function placeLink(a, broken = false, label = null) {
        return $('button', { type: 'button', class: `linkish cast-placelink${broken ? ' broken' : ''}`, 'data-place': a, title: broken ? 'Not in this world' : 'Show on the map', onclick: () => io.showPlace?.(a) }, label ?? placeName(a));
    }
    function sourcedTable(cardRows, { cls = '' } = {}) {
        const tbl = $('table', { class: `resolved${cls ? ` ${cls}` : ''}` });
        for (const row of cardRows) {
            const changed = /message #|effect:|this chat|created in this chat/.test(row.source ?? '');
            tbl.append($('tr', { 'data-key': row.key }, $('th', {}, row.key), $('td', {},
                $('div', { class: 'val' }, row.value ?? ''),
                row.source ? $('div', { class: `src${row.source === 'cast file' ? ' own' : ''}${row.stale ? ' stale' : ''}${row.pending ? ' pending' : ''}` }, ...(changed ? [$('span', { class: 'patchmark', title: 'changed in this chat' })] : []), row.source) : null)));
        }
        return tbl;
    }
    function scheduleBlock(r) {
        const places = r.play ? liveSchedule(r.rec?.ok ? r.rec : null, r.play).map(e => $('li', { class: `cast-schedrow src-${e.src}${e.current ? ' current' : ''}` }, e.place ? placeLink(e.place, false) : $('span', { class: 'muted' }, 'off the map'),
            ` ${e.activity}${e.where ? ` (${e.where})` : ''}${e.near && !e.place ? ` near ${e.near}` : ''}${e.from || e.to ? ` ${e.from}–${e.to}` : ''}${e.importance ? ` · ${e.importance}` : ''}`,
            ...e.notes.map(n => $('span', { class: 'cast-schednote' }, ` · ${n}`)), e.current ? $('b', { class: 'cast-schednow' }, ' ← now') : '', $('span', { class: 'muted' }, e.src === 'card' ? ' (card)' : ''))) : (r.rec?.schedule ?? []).map(e => $('li', {}, e.place ? placeLink(e.place, e.broken) : $('span', { class: 'muted' }, 'off the map'),
            ` ${e.activity}${e.where ? ` (${e.where})` : ''}${e.near ? ` near ${e.near}` : ''}${e.nearNote ? ` · ${e.nearNote}` : ''}${e.from || e.to ? ` ${e.from ?? ''}–${e.to ?? ''}` : ''}${e.importance ? ` · ${e.importance}` : ''}${e.broken ? ` (${e.problem})` : ''}`));
        if (r.rec?.seen_at) places.push($('li', {}, placeLink(r.rec.seen_at.place, r.rec.seen_at.broken), ` sometimes, around ${r.rec.seen_at.hour}:00 (${Math.round((r.rec.seen_at.chance ?? 0.5) * 100)}%)`));
        return places.length ? [$('b', {}, 'Schedule'), $('ul', { class: 'cast-sched' }, ...places)] : [];
    }
    function appearanceRetry(play) {
        if (!play || play.appearanceHow !== 'pending') return null;
        const job = play.appearanceJob;
        const working = job?.status === 'working';
        const why = job?.reason ? $('div', { class: 'cast-pending' }, job.reason) : null;
        let btn;
        btn = $('button', { type: 'button', class: 'crumb cast-retry', ...(working ? { disabled: '' } : {}), onclick: () => {
            if (btn.disabled) return;
            btn.disabled = true;
            const at = io.chatAt?.();
            io.retryAppearance?.({ id: play.id, msg: job?.msg ?? at?.msg, key: job?.key || '' });
        } }, working ? 'Rewriting…' : 'Retry rewrite');
        return $('div', { class: 'cast-appearretry' }, why, btn);
    }
    function drawResolved(r, pane) {
        const app = cardAppearance(r.rec, r.play);
        const landedLooks = ['Looks', app.looks];
        const card = resolvedCard(r.rec, r.play).map(row => row.key === 'Looks' && row.landed ? { ...row, value: landedLooks[1] } : row);
        pane.append(sourcedTable(card), appearanceRetry(r.play), ...scheduleBlock(r));
    }
    function paintEffective(box, play, rec) {
        if (!play) { box.hidden = true; box.replaceChildren(); return; }
        box.hidden = false;
        const app = cardAppearance(rec, play);
        const pending = play.appearanceHow === 'pending';
        const line = (label, text) => $('div', {}, $('b', {}, label), ' ', pending ? 'pending rebuild' : (text || '—'));
        const stale = pending && ['looks', 'body', 'outfit'].some(k => (play[k] ?? '') !== (play.base?.[k] ?? ''));
        box.replaceChildren($('b', {}, 'Narrator now (read-only)'), line('Looks', app.looks), line('Body', app.body), line('Outfit', app.outfit),
            pending ? $('div', { class: 'cast-pending' }, 'pending rebuild — not narrator text yet') : null,
            appearanceRetry(play),
            stale ? $('div', { class: 'muted' }, 'An older preview is stale.') : null);
    }
    function permanentBox(r) {
        const founds = r.play ? activeFounds(r.play) : [];
        if (!r.rec?.ok || !founds.length) return null;
        const perm = $('div', { class: 'cast-permanent' });
        for (const f of founds) perm.append($('button', { type: 'button', class: 'crumb cast-makepermanent', 'data-where': f.where, onclick: () => makePermanent(r, f, perm) },
            `Make this permanent${f.where ? ` (${f.where})` : ''}: ${placeName(f.place)}`));
        return perm;
    }
    function statePane(r) {
        if (!r.play) return [$('p', { class: 'muted' }, 'Open a chat to see where they are and why.')];
        const why = whyRows(r.play, placeName);
        const chat = playSummary(r.play, placeName).map(([k, v]) => ({ key: k, value: k === 'Where' && r.play.position?.place ? placeLink(r.play.position.place, false, v) : v }));
        return [why.length ? $('b', {}, 'Right now') : null, why.length ? $('table', { class: 'resolved cast-why' }, ...why.map(([k, v]) => $('tr', { 'data-row': k }, $('th', {}, k), $('td', {}, v)))) : null,
            $('b', {}, 'In this chat'), sourcedTable(chat, { cls: 'cast-inchat' }), permanentBox(r)].filter(Boolean);
    }
    function changesPane(r) {
        if (!r.play) return [$('p', { class: 'muted' }, 'Open a chat to see what changed.')];
        const st = stampRows(r.play);
        return [st.length ? $('ul', { class: 'cast-stamps' }, ...st.map(x => $('li', { class: x.off ? 'off' : '', 'data-type': x.type },
            $('button', { type: 'button', class: 'linkish cast-msglink', 'data-msg': x.msg, title: 'Show this message in SillyTavern', onclick: () => io.showMessage?.(x.msg) }, `#${x.msg}`), ' ', x.text, x.off ? ' (turned off)' : '')))
            : $('p', { class: 'muted' }, 'Nothing has changed for them in this chat.'), permanentBox(r)].filter(Boolean);
    }
    function warnPane(r) {
        return r.problems?.length ? [$('ul', { class: 'warnings' }, ...r.problems.map(p => $('li', {}, p)))] : [$('p', { class: 'muted' }, 'No loader warnings for this.')];
    }
    function rawPane(r) {
        const hasFile = !!r.rec;
        const label = hasFile ? `cast/${r.rec.file ?? `${r.id}.json`}` : "Not in a cast file (this chat's played record).";
        const body = hasFile ? (r.rec.raw ?? r.rec) : (r.play?.record ?? {});
        return [$('p', { class: 'muted' }, label), $('pre', { class: 'raw' }, JSON.stringify(body, null, 2))];
    }
    function fileActs(r) {
        const live = liveChat() && !!r.play;
        const box = $('div', { class: 'area cast-fileacts' });
        box.append($('span', { class: 'muted' }, r.status === 'play' ? 'in this chat' : r.status === 'broken' ? 'broken cast file' : 'cast file'),
            $('button', { type: 'button', class: 'crumb editlive cast-edit', title: live ? 'Change this in this chat only. It is stamped on the latest message. The cast file is not touched.' : 'Open a WorldScrawl chat to edit', ...(live ? {} : { disabled: '' }), onclick: () => openDraft(r, 'chat') }, 'Edit'),
            $('button', { type: 'button', class: 'crumb cast-saveas', title: 'Write a new cast file from the base plus lasting chat changes. A temporary transformation is not included.', onclick: () => openDraft(r, 'saveas') }, 'Save as new NPC'));
        if (r.rec && r.play && authoringChanges(r.rec, r.play).length) box.append($('button', { type: 'button', class: 'crumb cast-update', title: 'Open the authoring form. Confirm shows exactly what will be written to the cast file.', onclick: () => openDraft(r, 'update') }, `Update ${r.name}`));
        if (r.rec) box.append($('button', { type: 'button', class: 'crumb cast-del', onclick: () => confirmDelete(r, box) }, 'Delete'));
        return box;
    }
    function drawDetail() {
        const r = row();
        if (!r && !editing) { detail.replaceChildren($('p', { class: 'muted' }, 'Pick someone to see them. Click a place on the map to see who is there.')); return; }
        if (!r) { detail.replaceChildren($('h3', {}, editing.title || 'New person'), $('div', { class: 'tabpane cast-edit' }, editing.el)); return; }
        if (!TABS.includes(tab)) tab = 'resolved';
        const bar = $('div', { class: 'tabs' }, ...TABS.map(k => $('button', { type: 'button', class: `tab${k === tab && !editing ? ' active' : ''}`, 'data-tab': k, onclick: () => { editing = null; tab = k; drawDetail(); } }, tabLabel(r, k))));
        const pane = $('div', { class: `tabpane cast-${editing ? 'edit' : tab}` });
        if (editing) {
            if (!editing.el) editing.el = buildForm(editing);
            pane.append(editing.el);
            const box = editing.el.querySelector('.cf-effective');
            if (box) paintEffective(box, r.play, r.rec);
        } else if (tab === 'resolved') drawResolved(r, pane);
        else if (tab === 'raw') pane.append(...rawPane(r));
        else if (tab === 'state') pane.append(...statePane(r));
        else if (tab === 'warnings') pane.append(...warnPane(r));
        else pane.append(...changesPane(r));
        detail.replaceChildren($('h3', {}, r.name), fileActs(r), bar, pane);
    }
    async function makePermanent(r, found, box) {
        const raw = r.rec?.raw ?? r.rec;
        if (!raw) return;
        const next = permanentSchedule(raw.schedule ?? r.rec.schedule ?? [], found.where, found.place);
        let basePlaces = null; try { basePlaces = (await io.load())?.places ?? null; } catch { /* checked below */ }
        const why = basePlaces ? permanentProblem(found.place, basePlaces) : 'Could not check the world files; try again.';
        if (why) { say(why, true); return; }
        if (!next.changed) { say('Nothing to write: no off-map entry uses that where.', true); return; }
        box.querySelectorAll('button').forEach(b => { b.disabled = true; });
        try {
            const res = await io.save({ ...raw, schedule: next.schedule }, r.id, r.rec.file);
            say(`Saved cast/${res.file}: ${found.where || 'that where'} is now ${placeName(found.place)}.`);
            await refresh(`file:${res.file}`);
        } catch (e) { say(`Not saved: ${e.message}`, true); box.querySelectorAll('button').forEach(b => { b.disabled = false; }); }
    }
    function confirmDelete(r, acts) {
        acts.querySelector('.cast-confirmdel')?.remove();
        const file = r.rec?.file ?? `${r.id}.json`;
        acts.append($('div', { class: 'cast-confirmdel' }, `Delete cast/${file}? The file is removed. Chats keep their stamps.`, ' ',
            $('button', { type: 'button', class: 'crumb cast-delyes', onclick: async () => {
                try { await io.del(r.rec?.ok ? { id: r.id } : { file }); } catch (e) { return say(`Delete failed: ${e.message}`, true); }
                for (const k of [...drafts.keys()]) if (k.startsWith(`${r.key}:`)) drafts.delete(k);
                say(`Deleted cast/${file}.`); editing = null; selKey = null; await refresh();
            } }, 'Yes, delete'), $('button', { type: 'button', class: 'crumb cast-delno', onclick: ev => ev.target.closest('.cast-confirmdel').remove() }, 'No')));
    }
    const takenIds = own => new Set(rows.filter(x => x.rec && x.id && x.id !== own).map(x => x.id).concat(rows.filter(x => x.rec?.file && x.id !== own).map(x => x.rec.file.replace(/\.json$/, ''))));

    function openDraft(r, mode) {
        if (r) selKey = r.key; else selKey = null;
        const key = `${r?.key ?? 'new'}:${mode}`;
        if (!drafts.has(key)) {
            const seed = mode === 'new' ? formFromRecord(null) : editSeed(r?.play, r?.rec ?? null);
            const f = structuredClone(seed);
            if (mode === 'saveas') {
                f.name = `${String(f.name || r?.name || 'Someone').replace(/ \(copy\)$/, '')} (copy)`;
                f.id = slugFor(f.id || f.name, takenIds(null));
            }
            drafts.set(key, {
                key, mode, f, seed: structuredClone(f), el: null,
                personKey: r?.key ?? null, personId: r?.id ?? null,
                original: mode === 'update' && r?.rec?.ok ? r.id : null,
                originalFile: mode === 'update' && r?.rec && !r.rec.ok ? r.rec.file : null,
                title: mode === 'new' ? 'New person' : mode === 'saveas' ? `Save ${r?.name ?? f.name} as new` : mode === 'update' ? `Update ${r?.name ?? f.name}` : `Edit ${r?.name ?? f.name}`,
            });
        }
        editing = drafts.get(key);
        if (!editing.el) editing.el = buildForm(editing);
        if (view !== 'people') { view = 'people'; drawViews(); drawView(); }
        drawList(); drawDetail();
    }
    // The live Edit form and the file authoring form. The DOM node is kept on the draft, so switching tabs does not drop what was typed.
    function buildForm(ed) {
        const chatMode = ed.mode === 'chat';
        const f = ed.f;
        const current = () => rows.find(x => x.key === ed.personKey) ?? null;
        const ownId = () => (ed.mode === 'update' ? (ed.original ?? (ed.originalFile ? ed.originalFile.replace(/\.json$/, '') : null)) : null);
        let idTouched = ed.mode !== 'new';
        const form = $('div', { class: `castform castform-${ed.mode}`, 'data-mode': ed.mode });
        const errs = new Map();
        const err = key => { const e = $('div', { class: 'cf-err', 'data-for': key }); errs.set(key, e); return e; };
        const fieldRow = (key, label, input, help = null) => $('div', { class: 'cf-row', 'data-field': key }, $('label', { class: 'pf-label' }, label), input, help ? $('div', { class: 'muted' }, help) : null, err(key));
        const text = (key, { area = false, ph = '' } = {}) => {
            const i = $(area ? 'textarea' : 'input', { ...(area ? { rows: 2 } : { type: 'text' }), class: 'pf-input', placeholder: ph });
            i.value = f[key] ?? '';
            i.addEventListener('input', () => { f[key] = i.value; if (key === 'name' && !idTouched) { f.id = slugFor(i.value, takenIds(ownId())); idIn.value = f.id; } check(); });
            return i;
        };
        const lines = key => { const i = $('textarea', { rows: 3, class: 'pf-input' }); i.value = (f[key] ?? []).join('\n'); i.addEventListener('input', () => { f[key] = i.value.split('\n'); check(); }); return i; };
        const idIn = $('input', { type: 'text', class: 'pf-input', spellcheck: 'false' }); idIn.value = f.id;
        idIn.addEventListener('input', () => { idTouched = true; f.id = idIn.value; check(); });
        const effBox = $('div', { class: 'cf-effective' });
        form.append(fieldRow('name', 'Name', text('name')), fieldRow('id', 'Id', idIn, 'The cast file name. Lowercase, like old-tam.'),
            fieldRow('unknownAs', 'Known as (before the name)', text('unknownAs', { ph: 'the landlady' }), 'What the player calls them until they learn the name. Empty: the name is used from the start.'),
            $('b', {}, 'Personality'),
            fieldRow('line', 'Summary', text('line', { ph: 'stern, watchful, sharp-tongued' }), 'Always fed while they are here.'),
            fieldRow('manner', 'Manner', text('manner', { area: true })), fieldRow('voice', 'Speech', text('voice')),
            $('b', {}, 'Appearance'), effBox,
            $('p', { class: 'muted' }, chatMode
                ? 'These fields start from the base (the file plus lasting changes). The narrator text above is not copied into a fact unless you change a field.'
                : 'These fields are what will be written. They start from the base plus lasting chat changes, not from a temporary transformation.'),
            fieldRow('looks', 'Summary', text('looks', { ph: 'big woman with copper braids, in plain work clothes' }), 'Always fed while they are here.'),
            fieldRow('body', 'Body', text('body', { area: true, ph: 'Physical only: build, age, face, hair, marks' })),
            fieldRow('outfit', 'Outfit', text('outfit', { area: true, ph: 'What they usually wear and carry' }), 'Body, outfit, manner and speech are fed when the player looks at or deals with them.'),
            fieldRow('history', 'History', text('history', { area: true, ph: 'Their life before the game starts' }), 'Fed only when a lore request names them ([lore] Hesk).'));
        const invented = current()?.play?.invented;
        if (chatMode && invented?.length) form.append($('p', { class: 'muted cf-invented' }, `Made up when remembered (not in the story): ${invented.join('; ')}`));
        const dsel = $('select', { class: 'pf-input' }, $('option', { value: '' }, 'unknown'), ...DISPOSITIONS.map(d => $('option', { value: d }, d)));
        dsel.value = f.disposition; dsel.addEventListener('change', () => { f.disposition = dsel.value; check(); });
        form.append(fieldRow('disposition', 'Starts toward the player', dsel), fieldRow('reason', 'Because', text('reason')));
        const schedBox = $('div', { class: 'cf-schedule' });
        const drawSched = () => {
            schedBox.replaceChildren(...(f.schedule ?? []).map((e, i) => {
                const off = $('input', { type: 'checkbox', class: 'cf-offmap' }); off.checked = !!e.offmap;
                off.addEventListener('change', () => { e.offmap = off.checked; if (off.checked) e.place = ''; drawSched(); check(); });
                const pk = pickField(doc, { kind: 'room', title: `place for ${e.activity || 'this entry'}`, outline, value: e.offmap ? '' : e.place });
                pk.addEventListener('change', () => { e.place = pk.value; if (pk.value) e.offmap = false; drawSched(); check(); });
                const act = $('input', { type: 'text', class: 'pf-input cf-activity', placeholder: 'doing what' }); act.value = e.activity; act.addEventListener('input', () => { e.activity = act.value; check(); });
                const wh = $('input', { type: 'text', class: 'pf-input cf-where', placeholder: 'where (her own room)' }); wh.value = e.where; wh.addEventListener('input', () => { e.where = wh.value; check(); });
                const nr = $('input', { type: 'text', class: 'pf-input cf-near', placeholder: 'near (a place, a stub, or words)' }); nr.value = e.near; nr.addEventListener('input', () => { e.near = nr.value; check(); });
                const tm = k => { const t = $('input', { type: 'time', class: `pf-input cf-${k}` }); t.value = e[k]; t.addEventListener('input', () => { e[k] = t.value; check(); }); t.addEventListener('change', () => { e[k] = t.value; check(); }); return t; };
                const imp = $('select', { class: 'pf-input cf-importance' }, $('option', { value: '' }, 'importance'), ...IMPORTANCE.map(x => $('option', { value: x }, x))); imp.value = e.importance; imp.addEventListener('change', () => { e.importance = imp.value; check(); });
                return $('div', { class: 'cf-sched', 'data-i': i }, $('div', { class: 'cf-schedtop' }, $('label', { class: 'cf-offlabel' }, off, ' Off the map'), pk, $('button', { type: 'button', class: 'pf-x cf-schedx', title: 'Remove this entry', onclick: () => { f.schedule.splice(i, 1); drawSched(); check(); } }, '✕')),
                    err(`schedule.${i}.place`),
                    e.offmap ? $('div', { class: 'cf-schedrow' }, wh, nr) : null,
                    $('div', { class: 'cf-schedrow' }, act, tm('from'), '–', tm('to'), imp),
                    err(`schedule.${i}.activity`), err(`schedule.${i}.from`), err(`schedule.${i}.to`), err(`schedule.${i}.importance`));
            }), $('button', { type: 'button', class: 'crumb cf-addsched', onclick: () => { f.schedule.push({ place: '', offmap: false, activity: '', where: '', near: '', from: '', to: '', importance: '' }); drawSched(); check(); } }, 'Add schedule entry'));
        };
        drawSched();
        form.append($('b', {}, 'Schedule'), $('div', { class: 'muted' }, chatMode
            ? 'A change here is stamped on the latest message and applies only in this chat. It is not written to the cast file.'
            : 'Entries are checked in order; one with no times fills the rest of the day. Off the map: no place, an activity, and optionally where they are and what that is near.'), schedBox);
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
        if (!chatMode) { drawSeen(); form.append($('b', {}, 'Sighting'), seenBox); }
        const relBox = $('div', { class: 'cf-rels' });
        const drawRels = () => relBox.replaceChildren(...(f.relationships ?? []).map((x, i) => {
            const w = $('input', { type: 'text', class: 'pf-input cf-relwho', placeholder: 'who' }); w.value = x.who; w.addEventListener('input', () => { x.who = w.value; check(); });
            const t = $('input', { type: 'text', class: 'pf-input cf-reltext', placeholder: 'how they stand' }); t.value = x.text; t.addEventListener('input', () => { x.text = t.value; check(); });
            return $('div', { class: 'cf-rel' }, w, t, $('button', { type: 'button', class: 'pf-x', onclick: () => { f.relationships.splice(i, 1); drawRels(); check(); } }, '✕'), err(`relationships.${i}.who`));
        }), $('button', { type: 'button', class: 'crumb', onclick: () => { f.relationships.push({ who: '', text: '' }); drawRels(); } }, 'Add relationship'));
        drawRels();
        form.append($('details', { class: 'cf-deep' }, $('summary', {}, 'Deep (secrets, relationships)'),
            fieldRow('secrets', 'Secrets (one per line)', lines('secrets')), $('b', {}, 'Relationships'), relBox),
            fieldRow('facts', 'Facts (one per line)', lines('facts')), fieldRow('memory', 'Memory highlights (one per line)', lines('memory')));
        const fileName = () => ed.originalFile ?? `${recordFromForm(f).id || 'new'}.json`;
        if (chatMode) { form.querySelector('[data-field="id"]')?.remove(); form.prepend($('p', { class: 'muted cf-modenote' }, 'Stamps the latest message of this chat. The cast file is not touched. Schedule changes here stay in this chat.')); }
        else form.prepend($('p', { class: 'muted cf-modenote' }, `Writes cast/${fileName()}. A temporary transformation is not copied in. Chats keep their stamps.`));
        const save = $('button', { type: 'button', class: 'crumb cast-save', onclick: () => review() }, chatMode ? 'Save in this chat' : ed.mode === 'update' ? 'Update' : 'Create');
        const cancel = $('button', { type: 'button', class: 'crumb cast-cancel', onclick: () => { drafts.delete(ed.key); if (editing === ed) editing = null; tab = 'resolved'; drawDetail(); } }, 'Cancel');
        const raw = $('pre', { class: 'raw cf-raw' });
        const reviewBox = $('div', { class: 'cast-review' });
        form.append($('div', { class: 'cast-acts' }, save, cancel), reviewBox, ...(chatMode ? [] : [$('details', { class: 'cf-advanced' }, $('summary', {}, 'Advanced: raw JSON'), raw)]));
        function review() {
            if (Object.keys(check()).length) return;
            let lines = [], notes = [];
            if (chatMode) { const c = chatStamps(ed.seed, f); ed.stamps = c.stamps; lines = chatStampLines(c.stamps); notes = c.cannot.map(x => `Can't ${x}.`); }
            else {
                const before = ed.mode === 'update' && current()?.rec ? recordFromForm(formFromRecord(current().rec)) : recordFromForm(formFromRecord(null));
                lines = recordChanges(before, recordFromForm(f)).map(x => `${x.field}: ${x.from || '(none)'} → ${x.to || '(none)'}`);
            }
            reviewBox.replaceChildren($('div', { class: 'cast-diff' }, $('b', {}, chatMode ? 'Stamps to add in this chat' : `This will be written to cast/${fileName()}`),
                lines.length ? $('ul', {}, ...lines.map(l => $('li', {}, l))) : $('p', { class: 'muted' }, 'Nothing changed.'),
                notes.length ? $('ul', { class: 'warnings' }, ...notes.map(l => $('li', {}, l))) : null,
                lines.length ? $('button', { type: 'button', class: 'crumb cast-confirm', onclick: () => doSave() }, 'Confirm') : null,
                $('button', { type: 'button', class: 'crumb', onclick: () => reviewBox.replaceChildren() }, 'Back')));
        }
        function check() {
            reviewBox.replaceChildren();
            const places = chatMode ? null : new Set(data?.places ?? []);
            const ids = chatMode ? new Set() : takenIds(ownId());
            const p = formProblems(f, { places, ids });
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
                const at = io.chatAt?.();
                if (!at || at.msg < 0) { say('Open the chat in SillyTavern first.', true); save.disabled = false; return; }
                const res = await io.chatEdit?.(current()?.id ?? ed.personId, ed.stamps ?? [], at);
                if (!res?.ok) { say(`Not saved: ${res?.error ?? 'SillyTavern did not answer.'}`, true); save.disabled = false; return; }
                say(`Saved ${res.count} change${res.count === 1 ? '' : 's'} on message #${res.msg}.`);
                drafts.delete(ed.key); if (editing === ed) editing = null; tab = 'changes'; drawDetail();
                return;
            }
            try {
                const res = await io.save(recordFromForm(f), ed.original, ed.originalFile);
                say(`Saved cast/${res.file}.`);
                drafts.delete(ed.key); if (editing === ed) editing = null; tab = 'resolved';
                await refresh(`file:${res.file}`);
            } catch (e) { say(`Not saved: ${e.message}`, true); save.disabled = false; }
        }
        check();
        return form;
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
    /** New map state (a chat turn): redraw the open person. An open form keeps its draft; only the read-only narrator text updates. */
    function setPlay() {
        if (!data) return;
        rows = castRows(data.npcs ?? [], io.play?.() ?? []);
        drawList();
        const box = editing?.el?.querySelector?.('.cf-effective');
        if (box) { const r = rows.find(x => x.key === editing.personKey); paintEffective(box, r?.play, r?.rec); }
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
