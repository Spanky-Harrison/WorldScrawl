// The cast browser and editor's data side (pure, no DOM): the list (cast files plus people created in play), search and
// filters, the editor form <-> cast record, inline validation, the in-play view's rows, and the map's NPC markers.
// The server validates again on save (plugin/npc.mjs validateRecord); these checks are for showing problems inline.
import { NPC_ID, authorRecord } from '../shared/npc.mjs';
export const DISPOSITIONS = ['hostile', 'unfriendly', 'indifferent', 'friendly', 'helpful'];
export const IMPORTANCE = ['low', 'normal', 'high'];
const HM = /^(\d{1,2}):(\d{2})$/;
const hmOk = t => { const m = HM.exec(String(t ?? '').trim()); return !!m && +m[1] < 24 && +m[2] < 60; };
const s = v => (typeof v === 'string' ? v.trim() : '');

/** Every place a cast record names (schedule and sighting). */
export function npcPlaces(rec) {
    const out = [];
    for (const e of rec?.schedule ?? []) if (e?.place) out.push(e.place);
    if (rec?.seen_at?.place) out.push(rec.seen_at.place);
    return [...new Set(out)];
}
/** Does an address sit at or inside a place / subregion (riverton:streets) / region (riverton)? */
export const within = (addr, p) => !!addr && !!p && (addr === p || addr.startsWith(`${p}/`) || (!p.includes(':') && addr.startsWith(`${p}:`)));

/**
 * One list for the browser. `cast` is GET /cast's npcs; `play` the map state's npcs (this chat, or []).
 * Each row: {key, id, name, line, status: 'cast'|'play'|'broken', rec (cast record or null), play (in-play state or null), places, disposition}.
 */
export function castRows(cast = [], play = []) {
    const byId = new Map((play ?? []).map(n => [n.id, n]));
    const rows = [];
    for (const rec of cast ?? []) {
        const broken = !rec.ok || (rec.schedule ?? []).some(e => e.broken) || !!rec.seen_at?.broken;
        const p = rec.ok ? byId.get(rec.id) ?? null : null;
        rows.push({ key: `file:${rec.file ?? rec.id}`, id: rec.id ?? '', name: rec.name || rec.id || rec.file || '(unnamed)', line: rec.line ?? '', status: broken ? 'broken' : 'cast',
            rec, play: p, places: npcPlaces(rec), disposition: (p?.disposition?.player?.value ?? rec.disposition?.player?.value) || 'unknown', problems: rec.problems ?? [] });
    }
    const castIds = new Set((cast ?? []).filter(r => r.ok).map(r => r.id));
    for (const p of play ?? []) if (!castIds.has(p.id)) rows.push({ key: `play:${p.id}`, id: p.id, name: p.name, line: p.line ?? '', status: 'play', rec: null, play: p,
        places: p.position?.place ? [p.position.place] : [], disposition: p.disposition?.player?.value || 'unknown', problems: [] });
    rows.sort((a, b) => a.name.localeCompare(b.name));
    return rows;
}

/** Search (name, id, line) and filters: place (a place, subregion or region; schedule, sighting, or where they are now), status, disposition. */
export function filterRows(rows, { q = '', place = '', status = '', disposition = '' } = {}) {
    const words = String(q).toLowerCase().split(/\s+/).filter(Boolean);
    return rows.filter(r => {
        if (status && r.status !== status) return false;
        if (disposition && r.disposition !== disposition) return false;
        if (place && !r.places.some(a => within(a, place)) && !within(r.play?.position?.place, place)) return false;
        const hay = `${r.name} ${r.id} ${r.line}`.toLowerCase();
        return words.every(w => hay.includes(w));
    });
}

/** Map markers: address -> [{id, name, now}]. With a chat, where each person is now; otherwise every scheduled / sighting place. */
export function markersByPlace(rows) {
    const out = new Map();
    const add = (a, r, now) => { if (!a) return; if (!out.has(a)) out.set(a, []); if (!out.get(a).some(x => x.id === r.id)) out.get(a).push({ id: r.id, name: r.name, now }); };
    for (const r of rows) {
        if (r.play) { if (r.play.position?.place) add(r.play.position.place, r, true); }
        else if (r.status !== 'play') for (const a of r.places) add(a, r, false);
    }
    return out;
}
/** Markers at a node: a room's own, or an area's (every room inside it). */
export function markersAt(markers, n) {
    const out = [];
    for (const [a, list] of markers) if (n.layer ? within(a, n.layer.level === 'region' ? n.layer.region : `${n.layer.region}:${n.layer.subregion}`) : a === n.id) for (const m of list) if (!out.some(x => x.id === m.id)) out.push(m);
    return out;
}

// ---- The editor form. Lists are arrays of strings; relationships are [{who, text}]; the schedule keeps its row order.
export function formFromRecord(rec = null) {
    const r = rec ?? {};
    const raw = r.raw && typeof r.raw === 'object' ? r.raw : r;
    const d = raw.disposition?.player ?? {};
    return {
        id: s(raw.id) || s(r.id), name: s(raw.name), unknownAs: s(raw.unknownAs),
        // A cast file (nested personality / appearance) or a loaded or folded record (flat line / manner / voice / looks / body / outfit).
        line: s(raw.personality?.summary ?? raw.line), manner: s(raw.personality?.manner ?? raw.manner), voice: s(raw.personality?.speech ?? raw.voice),
        looks: s(raw.appearance?.summary ?? raw.looks), body: s(raw.appearance?.body ?? raw.body), outfit: s(raw.appearance?.outfit ?? raw.outfit),
        history: s(raw.history ?? raw.deep?.history), secrets: Array.isArray(raw.deep?.secrets) ? raw.deep.secrets.map(String) : [],
        relationships: Object.entries(raw.deep?.relationships ?? {}).map(([who, text]) => ({ who, text: String(text ?? '') })),
        facts: Array.isArray(raw.facts) ? raw.facts.map(String) : [], memory: Array.isArray(raw.memory) ? raw.memory.map(x => (typeof x === 'string' ? x : x?.note ?? '')) : [],
        disposition: s(d.value) || '', reason: s(d.reason),
        others: Object.fromEntries(Object.entries(raw.disposition ?? {}).filter(([k]) => k !== 'player')),
        schedule: (Array.isArray(raw.schedule) ? raw.schedule : []).map(e => ({
            place: s(e?.place), offmap: !s(e?.place) && !!(s(e?.activity) || s(e?.where) || s(e?.near)),
            activity: s(e?.activity), where: s(e?.where), near: s(e?.near), from: s(e?.from), to: s(e?.to), importance: s(e?.importance),
        })),
        seen: raw.seen_at && typeof raw.seen_at === 'object' ? { place: s(raw.seen_at.place), hour: raw.seen_at.hour ?? '', chance: raw.seen_at.chance ?? 0.5 } : null,
    };
}
export function recordFromForm(f) {
    const out = { id: s(f.id), name: s(f.name) };
    if (s(f.unknownAs)) out.unknownAs = s(f.unknownAs);
    out.personality = { summary: s(f.line) };
    if (s(f.manner)) out.personality.manner = s(f.manner);
    if (s(f.voice)) out.personality.speech = s(f.voice);
    const look = {};
    if (s(f.looks)) look.summary = s(f.looks);
    if (s(f.body)) look.body = s(f.body);
    if (s(f.outfit)) look.outfit = s(f.outfit);
    if (Object.keys(look).length) out.appearance = look;
    if (s(f.history)) out.history = s(f.history);
    const disp = { ...(f.others ?? {}) };
    if (s(f.disposition)) disp.player = { value: s(f.disposition), ...(s(f.reason) ? { reason: s(f.reason) } : {}) };
    if (Object.keys(disp).length) out.disposition = disp;
    const sched = (f.schedule ?? []).map(e => {
        const placed = !e.offmap && !!s(e.place);
        const x = { activity: s(e.activity) };
        if (placed) x.place = s(e.place);
        else {
            if (s(e.where)) x.where = s(e.where);
            if (s(e.near)) x.near = s(e.near);
        }
        if (s(e.from)) x.from = s(e.from);
        if (s(e.to)) x.to = s(e.to);
        if (s(e.importance)) x.importance = s(e.importance);
        if (x.place) { const { place, activity, ...rest } = x; return { place, activity, ...rest }; }
        return x;
    }).filter(e => e.activity);
    if (sched.length) out.schedule = sched;
    if (f.seen && s(f.seen.place)) out.seen_at = { place: s(f.seen.place), hour: Number(f.seen.hour), chance: Number(f.seen.chance) };
    const deep = {};
    const secrets = (f.secrets ?? []).map(s).filter(Boolean);
    if (secrets.length) deep.secrets = secrets;
    const rel = {};
    for (const r of f.relationships ?? []) if (s(r.who) && s(r.text)) rel[s(r.who)] = s(r.text);
    if (Object.keys(rel).length) deep.relationships = rel;
    if (Object.keys(deep).length) out.deep = deep;
    const facts = (f.facts ?? []).map(s).filter(Boolean), memory = (f.memory ?? []).map(s).filter(Boolean);
    if (facts.length) out.facts = facts;
    if (memory.length) out.memory = memory;
    return out;
}
/** A slug from a name ("Old Tam" -> "old-tam"), made free against `taken`. */
export function slugFor(name, taken = new Set()) {
    const base = String(name ?? '').toLowerCase().normalize('NFKD').replace(/['\u2019\u2018]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'npc';
    let id = base, n = 2;
    while (taken.has(id)) id = `${base}-${n++}`;
    return id;
}

/**
 * Inline problems: {field: message} with keys like 'id', 'name', 'schedule.0.place', 'seen.hour'.
 * `places` is a Set of this world's addresses; `ids` the ids other cast files use (not this one's own).
 */
export function formProblems(f, { places = null, ids = new Set() } = {}) {
    const p = {};
    const id = s(f.id);
    if (!id) p.id = 'An id is required.';
    else if (!NPC_ID.test(id)) p.id = 'Use lowercase letters, digits, and - or _ between them (like old-tam).';
    else if (ids.has(id)) p.id = `Another cast file already uses the id ${id}.`;
    if (!s(f.name)) p.name = 'A name is required.';
    if (!s(f.line)) p.line = 'One line about who they are is required.';
    if (s(f.disposition) && !DISPOSITIONS.includes(s(f.disposition))) p.disposition = `One of ${DISPOSITIONS.join(', ')}.`;
    (f.schedule ?? []).forEach((e, i) => {
        if (e.offmap) { /* a placeless entry: off the map, place not required */ }
        else if (!s(e.place)) p[`schedule.${i}.place`] = 'Choose a place on the map, or tick Off the map.';
        else if (places && !places.has(s(e.place))) p[`schedule.${i}.place`] = `${e.place} is not in this world. Choose another place.`;
        if (!s(e.activity)) p[`schedule.${i}.activity`] = e.offmap ? 'What are they doing off the map?' : 'What are they doing there?';
        if (s(e.from) && !hmOk(e.from)) p[`schedule.${i}.from`] = 'A time like 08:00.';
        if (s(e.to) && !hmOk(e.to)) p[`schedule.${i}.to`] = 'A time like 17:00.';
        if (s(e.importance) && !IMPORTANCE.includes(s(e.importance))) p[`schedule.${i}.importance`] = 'low, normal or high.';
    });
    if (f.seen) {
        if (!s(f.seen.place)) p['seen.place'] = 'Choose a place on the map.';
        else if (places && !places.has(s(f.seen.place))) p['seen.place'] = `${f.seen.place} is not in this world. Choose another place.`;
        const h = Number(f.seen.hour);
        if (f.seen.hour === '' || !Number.isInteger(h) || h < 0 || h > 23) p['seen.hour'] = 'An hour from 0 to 23.';
        const c = Number(f.seen.chance);
        if (f.seen.chance === '' || !Number.isFinite(c) || c < 0 || c > 1) p['seen.chance'] = 'A chance from 0 to 1.';
    }
    (f.relationships ?? []).forEach((r, i) => { if (s(r.text) && !s(r.who)) p[`relationships.${i}.who`] = 'Who is this about?'; });
    return p;
}

const KIND = { follow: 'following', stay: 'staying', sight: 'seen here', schedule: 'on schedule', scene: 'here' };
/**
 * Looks, Body and Outfit the cast card shows. In a chat that is the effective appearance
 * (base plus active effects and rebuild caches — the same text the narrator is told).
 * With no chat state it is the cast file. `changed` is true when a chat rewrite differs from the file.
 */
export function cardAppearance(rec, play) {
    const file = rec?.ok ? rec : null;
    const src = play ?? file ?? rec ?? {};
    const looks = src.looks ?? '';
    const body = src.body ?? '';
    const outfit = src.outfit ?? '';
    const changed = !!(file && play && ['looks', 'body', 'outfit'].some(k => (src[k] ?? '') !== (file[k] ?? '')));
    return { looks, body, outfit, changed };
}

const APP = ['looks', 'body', 'outfit'];
const APP_NAME = { looks: 'Looks', body: 'Body', outfit: 'Outfit' };
const APP_FACT = { looks: ['appearance.summary', 'looks'], body: ['appearance.body', 'body', 'appearance'], outfit: ['appearance.outfit', 'outfit'] };
const TEXT_FACT = {
    line: ['personality.summary', 'line'], manner: ['personality.manner', 'manner'], voice: ['personality.speech', 'voice'],
    unknownAs: ['unknownAs'], history: ['history', 'deep.history'],
};
const onStamps = play => (play?.stamps ?? []).filter(s => s && !s.off && !s.pending);
const effectKeyOf = s => `${String(s.intent ?? '').trim().toLowerCase()}|${(s.fields ?? APP).slice().sort().join('+')}`;
const activeEffectKeys = play => new Set((play?.effects ?? []).map(effectKeyOf));
/** Join source labels. A value that still equals the cast file keeps that label beside any stamps that also wrote it. */
function fieldSource(play, rec, value, fileValue, extras = []) {
    const fromFile = !!(rec && (rec.ok || rec.file || rec.raw));
    const same = (value ?? '') === (fileValue ?? '');
    const labels = [];
    if (play && same && fromFile) labels.push('cast file');
    for (const x of extras) if (x && !labels.includes(x)) labels.push(x);
    if (!labels.length) {
        if (!play) return 'cast file';
        if (fromFile && same) return 'cast file';
        const created = onStamps(play).find(s => s.type === 'npc_create');
        if (!fromFile && created) return `message #${created.msg}`;
        return fromFile ? 'this chat' : 'created in this chat';
    }
    return labels.join(', ');
}
function factLabels(play, fields) {
    const want = new Set(fields);
    return onStamps(play).filter(s => s.type === 'npc_fact' && want.has(s.field || 'fact')).map(s => `message #${s.msg}`);
}
function narrExtras(play, field) {
    const active = activeEffectKeys(play);
    const out = factLabels(play, APP_FACT[field]);
    for (const s of onStamps(play)) {
        if (s.type === 'npc_appearance' && (s.fields ?? APP).includes(field)) {
            if (active.size && !active.has(effectKeyOf(s))) continue;
            out.push(`message #${s.msg}`);
            if (s.intent) out.push(`effect: ${s.intent}`);
        }
    }
    // A body or outfit rewrite also belongs on the Looks row once that replay has landed.
    if ((play?.appearanceHow === 'reuse' || play?.appearanceHow === 'model') && (play?.[field] ?? '') !== (play?.base?.[field] ?? '')) {
        for (const e of play?.effects ?? []) if (e.intent) out.push(`effect: ${e.intent}`);
    }
    return out;
}
function appearanceRows(rec, play) {
    const file = { looks: rec?.looks ?? '', body: rec?.body ?? '', outfit: rec?.outfit ?? '' };
    if (play?.appearanceHow === 'pending') {
        const why = play.appearanceJob?.reason ? ` — ${play.appearanceJob.reason}` : '';
        const rows = APP.map(k => ({ key: APP_NAME[k], value: 'pending rebuild', source: `pending rebuild${why}`, pending: true, landed: false }));
        const pendingFx = (play.effects ?? []).map(e => (e.intent ? `effect: ${e.intent}` : '')).filter(Boolean);
        for (const row of rows) if (pendingFx.length) row.source = [`pending rebuild${why}`, ...pendingFx].join(', ');
        return rows;
    }
    const summaryPending = play && play.appearanceHow !== 'pending' && (play.looksHow === 'pending' || play.looksHow === 'failed');
    const eff = play ? { looks: play.looks ?? '', body: play.body ?? '', outfit: play.outfit ?? '' } : file;
    const rows = [];
    for (const k of APP) {
        if (k === 'looks' && summaryPending) {
            const why = play.appearanceJob?.part === 'looks' && play.appearanceJob?.reason ? ` — ${play.appearanceJob.reason}` : '';
            rows.push({ key: 'Looks', value: 'pending summary', source: `pending summary${why}`, pending: true, landed: false });
            continue;
        }
        if (!(eff[k] || file[k])) continue;
        rows.push({ key: APP_NAME[k], value: eff[k], source: fieldSource(play, rec, eff[k], file[k], play ? narrExtras(play, k) : []), landed: !!play });
    }
    return rows;
}
const dispText = d => (!d?.value || d.value === 'unknown' ? 'unknown' : `${d.value}${d.reason ? ` (${d.reason})` : ''}`);
/**
 * Resolved rows for one person: {key, value, source, landed?, pending?, stale?}.
 * Personality comes from the folded card when a chat is open. Looks/Body/Outfit are the live appearance.
 * While a rebuild is pending the row says so — cast-file prose is not labeled as narrator text.
 * Source labels describe that live row. The file's original text stays on Raw.
 */
export function resolvedCard(rec, play) {
    const file = rec && (rec.ok || rec.file || rec.raw) ? rec : null;
    const rows = [{ key: 'Id', value: play?.id || file?.id || '(none)', source: file ? 'cast file' : 'created in this chat' }];
    const text = (key, label, value, fileValue, factFields) => {
        if (!value) return;
        rows.push({ key: label, value, source: fieldSource(play, file, value, fileValue ?? '', play ? factLabels(play, factFields) : []) });
    };
    const known = play ? (play.unknownAs ?? '') : (file?.unknownAs ?? '');
    text('unknownAs', 'Known as', known, file?.unknownAs ?? '', TEXT_FACT.unknownAs);
    const line = play ? (play.line ?? '') : (file?.line ?? '');
    rows.push({ key: 'Personality', value: line, source: fieldSource(play, file, line, file?.line ?? '', play ? factLabels(play, TEXT_FACT.line) : []) });
    text('manner', 'Manner', play ? (play.manner ?? '') : (file?.manner ?? ''), file?.manner ?? '', TEXT_FACT.manner);
    text('voice', 'Speech', play ? (play.voice ?? '') : (file?.voice ?? ''), file?.voice ?? '', TEXT_FACT.voice);
    rows.push(...appearanceRows(file, play));
    const history = play ? (play.deep?.history ?? '') : (file?.deep?.history ?? '');
    text('history', 'History', history, file?.deep?.history ?? '', TEXT_FACT.history);
    const facts = play ? [...(play.facts ?? [])] : [...(file?.facts ?? [])];
    if (facts.length) {
        const fileFacts = (file?.facts ?? []).join('; ');
        const now = facts.join('; ');
        const labels = play ? onStamps(play).filter(s => s.type === 'npc_fact' && (s.field || 'fact') === 'fact').map(s => `message #${s.msg}`) : [];
        rows.push({ key: 'Facts', value: now, source: fieldSource(play, file, now, fileFacts, labels) });
    }
    const d = play?.disposition?.player ?? file?.disposition?.player;
    const dFile = dispText(file?.disposition?.player);
    const dNow = dispText(d);
    rows.push({ key: 'Disposition', value: play ? dNow : dFile, source: fieldSource(play, file, play ? dNow : dFile, dFile, onStamps(play).filter(s => s.type === 'npc_disposition').map(s => `message #${s.msg}`)) });
    return rows;
}
/** The Edit / Update / Save-as-new seed: base appearance plus lasting chat changes. Not the resolved card. */
export function editSeed(play, rec = null) {
    if (!play) return formFromRecord(rec ?? null);
    const authored = authorRecord(play);
    return formFromRecord(authored ?? play.record ?? play);
}
/** Field changes Update would write. Empty when a temporary transformation is the only difference. */
export function authoringChanges(rec, play) {
    if (!rec || !play) return [];
    return recordChanges(recordFromForm(formFromRecord(rec)), recordFromForm(editSeed(play, rec)));
}

/** The in-play summary rows for one person: [label, text]. */
export function playSummary(play, placeName = a => a) {
    if (!play) return [];
    const rows = [];
    const pos = play.position;
    const off = play.why?.schedule?.offmap ? play.why.schedule : null;
    rows.push(['Where', off ? `off the map — ${off.activity || 'away'}${off.where ? ` (${off.where})` : ''}` : pos?.place ? `${placeName(pos.place)}${pos.activity ? ` (${pos.activity})` : ''}` : 'off the map right now']);
    rows.push(['Status', play.following ? `following ${play.following.who === 'player' ? 'you' : play.following.who}` : play.held ? `staying at ${placeName(play.held.place)}` : KIND[pos?.kind] ?? 'on their own schedule']);
    if (play.present) rows.push(['Scene', 'in your scene now']);
    const d = play.disposition?.player;
    rows.push(['Toward you', d ? `${d.value}${d.reason ? ` (${d.reason})` : ''}` : 'unknown']);
    rows.push(['Knows you', relText(play.rel?.player)]);
    if (play.memory?.length) rows.push(['Remembers', play.memory.slice(-3).join('; ')]);
    return rows;
}
const REL_SHOWN = { unmet: "hasn't met you", met: "met you, doesn't know your name", named: 'knows your name' };
/** "met you, doesn't know your name (message #4, memory)": the relationship state and the stamp that set it. */
export function relText(r) {
    if (!r?.state) return REL_SHOWN.unmet;
    return `${REL_SHOWN[r.state] ?? r.state}${r.at != null ? ` (message #${r.at}${r.by ? `, ${r.by}` : ''})` : ''}`;
}
/** The in-play changes list, oldest first. Identity and the decision revision stay on the row so Changes can call the same dispatcher as the chat card. */
export const stampRows = play => (play?.stamps ?? []).filter(x => x.type !== 'npc_decline').map(x => ({
    msg: x.msg, type: x.type,
    text: `${x.summary}${x.candidate ? ` (${x.candidate})` : ''}${x.preview ? `: ${x.preview}` : ''}${x.pending && !x.candidate ? ' (⏳ waiting on you)' : ''}${expiryText(x.expiry)}`,
    off: !!x.off, pending: !!x.pending, identity: x.identity || null, decisionRev: x.decisionRev ?? 1,
    candidate: x.candidate || '', candidateToken: x.candidateToken || '',
    diffs: Array.isArray(x.diffs) ? x.diffs : null,
}));
const pad2 = n => String(n).padStart(2, '0');
/** ' (lasting)', ' (until day 3 14:00)', ' (ended day 3 14:00)', ' (for 2h)': when a field change ends. */
export function expiryText(e) {
    if (!e) return '';
    if (e.lasting) return ' (lasting)';
    const u = e.until;
    if (!u) return ` (for ${e.lasts}m)`;
    return ` (${e.over ? 'ended' : 'until'} day ${u.day} ${pad2(u.hour)}:${pad2(u.minute)})`;
}

// ---- Diffs on submit, and "In this chat" edits as stamps.
const show = v => (v === undefined || v === null || v === '' ? '' : typeof v === 'string' ? v : JSON.stringify(v));
/** Field-by-field changes between two cast records: [{field, from, to}]. */
export function recordChanges(a = {}, b = {}) {
    const out = [];
    const keys = [...new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})])].filter(k => k !== 'raw' && k !== 'ok' && k !== 'file' && k !== 'problems');
    for (const k of keys) if (JSON.stringify(a?.[k] ?? null) !== JSON.stringify(b?.[k] ?? null)) out.push({ field: k, from: show(a?.[k]), to: show(b?.[k]) });
    return out;
}
/** Form text fields -> the card field a chat stamp sets. */
export const FORM_FIELDS = { line: 'personality.summary', manner: 'personality.manner', voice: 'personality.speech', looks: 'appearance.summary', body: 'appearance.body', outfit: 'appearance.outfit', history: 'history', unknownAs: 'unknownAs' };
/** A form for "In this chat": the person as the chat has them now (their folded state, not the cast file). */
export function formFromPlay(play) {
    const f = formFromRecord(play?.record ?? play ?? {});
    const d = play?.disposition?.player;
    if (d) { f.disposition = d.value === 'unknown' ? '' : d.value ?? ''; f.reason = d.reason ?? ''; }
    return f;
}
/** A cast editor form (not a play record): relationships are [{who, text}] and disposition is a string. */
const isForm = x => !!x && Array.isArray(x.relationships) && typeof x.disposition === 'string' && Array.isArray(x.schedule);
const scheduleJson = f => JSON.stringify(recordFromForm({ id: 'x', name: 'x', line: 'x', schedule: f?.schedule ?? [] }).schedule ?? null);
/**
 * The stamps that make the chat match the form, diffed against the opening seed (a form) or, if given a play
 * record, against that record as it is now. Unchanged fields, including appearance the user did not edit, are not stamped.
 * Removals of facts, secrets and memories cannot be stamped; they are reported. A schedule change is one npc_schedule stamp.
 */
export function chatStamps(playOrSeed, f) {
    const base = isForm(playOrSeed) ? playOrSeed : formFromPlay(playOrSeed);
    const stamps = [], cannot = [];
    for (const [k, field] of Object.entries(FORM_FIELDS)) if (s(f[k]) !== s(base[k])) {
        if (k === 'looks') { cannot.push('edit Looks (it is derived from body and outfit)'); continue; }
        if (k === 'body' || k === 'outfit') { if (s(f[k])) stamps.push({ type: 'npc_baseline', field: k, text: s(f[k]) }); else cannot.push(`clear ${field}`); continue; }
        if (s(f[k])) stamps.push({ type: 'npc_fact', field, text: s(f[k]) }); else cannot.push(`clear ${field}`);
    }
    const added = (now, was) => now.map(s).filter(Boolean).filter(x => !was.map(s).includes(x));
    const removed = (now, was) => was.map(s).filter(Boolean).filter(x => !now.map(s).includes(x));
    for (const t of added(f.facts ?? [], base.facts)) stamps.push({ type: 'npc_fact', field: 'fact', text: t });
    for (const t of added(f.secrets ?? [], base.secrets)) stamps.push({ type: 'npc_fact', field: 'deep.secrets', text: t });
    for (const t of added(f.memory ?? [], base.memory)) stamps.push({ type: 'npc_memory', note: t });
    for (const r of f.relationships ?? []) { const was = (base.relationships ?? []).find(x => x.who === s(r.who)); if (s(r.who) && s(r.text) && s(was?.text) !== s(r.text)) stamps.push({ type: 'npc_fact', field: `deep.relationships.${s(r.who)}`, text: s(r.text) }); }
    for (const [k, list] of [['facts', 'fact'], ['memory', 'memory'], ['secrets', 'secret']]) for (const t of removed(f[k] ?? [], base[k] ?? [])) cannot.push(`remove ${list} "${t}" (turn its stamp off in the chat instead)`);
    if (s(f.disposition) !== s(base.disposition) || (s(f.disposition) && s(f.reason) !== s(base.reason))) {
        if (s(f.disposition)) stamps.push({ type: 'npc_disposition', who: 'player', value: s(f.disposition), reason: s(f.reason), dramatic: true });
        else cannot.push('set disposition back to unknown');
    }
    if (scheduleJson(f) !== scheduleJson(base)) stamps.push({ type: 'npc_schedule', schedule: recordFromForm({ id: 'x', name: 'x', line: 'x', schedule: f.schedule ?? [] }).schedule ?? [] });
    return { stamps, cannot };
}
const stampText = x => (x.type === 'npc_memory' ? `memory: ${x.note}` : x.type === 'npc_disposition' ? `toward the player: ${x.value}${x.reason ? ` (${x.reason})` : ''}` : x.type === 'npc_schedule' ? `schedule: ${(x.schedule ?? []).map(e => `${e.place || e.where || 'off the map'} — ${e.activity || ''}`).join('; ') || '(none)'}` : `${x.field === 'fact' ? 'fact' : x.field}: ${x.text}`);
export const chatStampLines = stamps => stamps.map(stampText);

/** Latest found room per `where` label (off stamps are ignored; a later stamp for the same label wins). */
export function activeFounds(play) {
    const map = new Map();
    for (const s of play?.stamps ?? []) {
        if (s?.type !== 'npc_found' || s.off || !s.place) continue;
        map.set(s.where ?? '', { where: s.where ?? '', place: s.place, msg: s.msg });
    }
    return [...map.values()];
}
/**
 * Write a found room into the base schedule: every placeless entry with that `where` label becomes a normal placed entry.
 * Returns {schedule, changed}.
 */
export function permanentSchedule(schedule, where, place) {
    const label = String(where ?? '').trim();
    let changed = 0;
    const out = (schedule ?? []).map(e => {
        if (!e || typeof e !== 'object' || String(e.place ?? '').trim()) return e;
        if (String(e.where ?? '').trim() !== label) return e;
        changed++;
        const x = { place, activity: e.activity ?? '' };
        if (e.from) x.from = e.from;
        if (e.to) x.to = e.to;
        if (e.importance) x.importance = e.importance;
        return x;
    });
    return { schedule: out, changed };
}

/** Inspector rows for one person: [label, text], from npcPlayState's `why`. */
export function whyRows(play, placeName = a => a) {
    const w = play?.why;
    if (!w) return [];
    const pad = n => String(n ?? 0).padStart(2, '0');
    const rows = [];
    if (w.clock) rows.push(['Game time', `day ${w.clock.day}, ${pad(w.clock.hour)}:${pad(w.clock.minute)}`]);
    const off = w.schedule?.offmap ? w.schedule : null;
    rows.push(['Where', off ? `off the map — ${off.activity || 'away'}${off.where ? ` (${off.where})` : ''}` : w.place ? `${placeName(w.place)}${play.position?.activity ? ` (${play.position.activity})` : ''}` : 'nowhere this hour']);
    if (off) {
        rows.push(['Where hint', off.where || '(no label)']);
        rows.push(['Near', off.near ? `${off.near.kind === 'map' ? 'map' : off.near.kind === 'stub' ? 'stub' : off.near.kind === 'text' ? 'text' : 'none'}: ${off.near.kind === 'text' ? off.near.text : (off.near.name || off.near.address || '')}${off.near.kind === 'map' ? ` (${off.near.address})` : ''}${off.near.about ? ` — ${off.near.about}` : ''}${off.near.kind === 'text' ? ` (${off.near.warn === 'typo' ? 'probably a typo' : 'not in the list'})` : ''}` : 'nowhere named']);
    }
    rows.push(['Why', w.reason || '']);
    rows.push(['Record', `${w.tier}${w.from === 'play' ? ', created in this chat' : ', from the cast file'}`]);
    rows.push(['Following', w.following ? (w.following.who === 'player' ? 'the player' : w.following.who) : 'no']);
    if (w.held) rows.push(['Staying', `${placeName(w.held.place)} (since #${w.held.at}${w.held.active ? ', still holding' : ', hold over'})`]);
    if (w.schedule) rows.push(['Schedule', w.schedule.offmap ? w.schedule.why : w.schedule.entry >= 0 ? `entry ${w.schedule.entry + 1}: ${w.schedule.activity || ''} at ${placeName(w.schedule.address)}${w.schedule.how && w.schedule.how !== 'here' && w.schedule.how !== 'exact' ? ` (${w.schedule.how})` : ''}. ${w.schedule.why}` : w.schedule.why]);
    const founds = activeFounds(play);
    if (founds.length) rows.push(['Found', founds.map(f => `${f.where || '(no label)'} → ${placeName(f.place)} (message #${f.msg})`).join('; ')]);
    if (play.foundAttempts?.length) rows.push(['Found flags', play.foundAttempts.map(a => `${a.ok ? 'accepted' : 'rejected'}${a.source ? ` (${a.source})` : ''}: ${a.reason}`).join(' · ')]);
    if (w.sighting) {
        const g = w.sighting;
        rows.push(['Sighting', g.active ? `${placeName(g.resolved)} around ${g.hour}:00, peak ${Math.round(g.chance * 100)}%. Today (day ${g.day}): chance now ${g.now}, roll ${g.roll}${g.seekRoll != null ? `, by-name roll ${g.seekRoll}` : ''} → ${g.wouldShow ? 'shows' : 'no-show'}${g.stamped ? ' (appearance stamped)' : ''}` : `${g.place}: ${g.note}`]);
    }
    rows.push(['Toward the player', `${w.disposition?.value ?? 'unknown'}${w.disposition?.reason ? ` (${w.disposition.reason})` : ''}`]);
    rows.push(['Knows the player', relText(play.rel?.player)]);
    rows.push(['Memory', w.memory?.length ? w.memory.join('; ') : '(none)']);
    if (w.declined) rows.push(['Scene', 'a "no" to remembering them was said in this scene']);
    return rows;
}

export const CHAT_ONLY_ROOM = 'This room only exists in this chat; save the room to the world first (Save world in the WorldScrawl settings, or /ws-save-world).';
/** Why a found place can't go into the base schedule: it isn't in the world files (only this chat's map has it). '' when fine. */
export function permanentProblem(place, basePlaces) {
    const set = basePlaces instanceof Set ? basePlaces : new Set(basePlaces ?? []);
    return place && !set.has(place) ? CHAT_ONLY_ROOM : '';
}

/**
 * The person's schedule as this chat has it: the card's entries with chat edits folded in (play.record), found
 * placements putting a where-label in a room, and a follow/stay override on top. Each row: {place, activity, where,
 * near, from, to, src: 'card'|'chat', notes: [], current}. `rec` is the card record; null play = the card as is.
 */
export function liveSchedule(rec, play) {
    const key = e => [e?.place ?? '', e?.activity ?? '', e?.where ?? '', e?.near ?? '', e?.from ?? '', e?.to ?? ''].join('|');
    const card = (rec?.schedule ?? []).filter(e => e && !e.broken);
    const cardKeys = new Set(card.map(key));
    const eff = play?.record?.schedule ?? card;
    const founds = new Map(activeFounds(play).map(f => [f.where, f]));
    const cur = play?.why?.schedule;
    const overriding = !!(play?.following || (play?.held && play?.why?.held?.active !== false));
    const rows = eff.map(e => {
        const notes = [];
        const src = cardKeys.has(key(e)) ? 'card' : 'chat';
        if (src === 'chat') notes.push('changed in this chat');
        let place = e.place ?? '';
        const f = !place ? founds.get(e.where ?? '') : null;
        if (f) { place = f.place; notes.push('found here this chat'); }
        const current = !overriding && !!cur && (cur.activity ?? '') === (e.activity ?? '') && (cur.where ?? '') === (e.where ?? '') && (!e.place || cur.address === e.place);
        return { place, activity: e.activity ?? '', where: e.where ?? '', near: e.near ?? '', from: e.from ?? '', to: e.to ?? '', importance: e.importance ?? '', src: f ? 'chat' : src, notes, current };
    });
    if (play?.following) rows.unshift({ place: '', activity: `following ${play.following.who === 'player' ? 'you' : play.following.who}`, where: '', near: '', from: '', to: '', importance: '', src: 'chat', notes: ['this chat (overrides the schedule)'], current: true });
    else if (play?.held?.place && play?.why?.held?.active !== false) rows.unshift({ place: play.held.place, activity: 'staying here', where: '', near: '', from: '', to: '', importance: '', src: 'chat', notes: ['this chat (overrides the schedule)'], current: true });
    return rows;
}
