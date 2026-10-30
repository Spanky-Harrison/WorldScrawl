// The cast browser and editor's data side (pure, no DOM): the list (cast files plus people created in play), search and
// filters, the editor form <-> cast record, inline validation, the in-play view's rows, and the map's NPC markers.
// The server validates again on save (plugin/npc.mjs validateRecord); these checks are for showing problems inline.
export const DISPOSITIONS = ['hostile', 'unfriendly', 'indifferent', 'friendly', 'helpful'];
export const IMPORTANCE = ['low', 'normal', 'high'];
export const NPC_ID = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/;
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
        id: s(raw.id) || s(r.id), name: s(raw.name), line: s(raw.line), manner: s(raw.manner), voice: s(raw.voice), appearance: s(raw.appearance),
        history: s(raw.deep?.history), secrets: Array.isArray(raw.deep?.secrets) ? raw.deep.secrets.map(String) : [],
        relationships: Object.entries(raw.deep?.relationships ?? {}).map(([who, text]) => ({ who, text: String(text ?? '') })),
        facts: Array.isArray(raw.facts) ? raw.facts.map(String) : [], memory: Array.isArray(raw.memory) ? raw.memory.map(x => (typeof x === 'string' ? x : x?.note ?? '')) : [],
        disposition: s(d.value) || '', reason: s(d.reason),
        others: Object.fromEntries(Object.entries(raw.disposition ?? {}).filter(([k]) => k !== 'player')),
        schedule: (Array.isArray(raw.schedule) ? raw.schedule : []).map(e => ({ place: s(e?.place), activity: s(e?.activity), from: s(e?.from), to: s(e?.to), importance: s(e?.importance) })),
        seen: raw.seen_at && typeof raw.seen_at === 'object' ? { place: s(raw.seen_at.place), hour: raw.seen_at.hour ?? '', chance: raw.seen_at.chance ?? 0.5 } : null,
    };
}
export function recordFromForm(f) {
    const out = { id: s(f.id), name: s(f.name), line: s(f.line) };
    if (s(f.manner)) out.manner = s(f.manner);
    if (s(f.voice)) out.voice = s(f.voice);
    if (s(f.appearance)) out.appearance = s(f.appearance);
    const disp = { ...(f.others ?? {}) };
    if (s(f.disposition)) disp.player = { value: s(f.disposition), ...(s(f.reason) ? { reason: s(f.reason) } : {}) };
    if (Object.keys(disp).length) out.disposition = disp;
    const sched = (f.schedule ?? []).map(e => ({ place: s(e.place), activity: s(e.activity), ...(s(e.from) ? { from: s(e.from) } : {}), ...(s(e.to) ? { to: s(e.to) } : {}), ...(s(e.importance) ? { importance: s(e.importance) } : {}) }));
    if (sched.length) out.schedule = sched;
    if (f.seen && s(f.seen.place)) out.seen_at = { place: s(f.seen.place), hour: Number(f.seen.hour), chance: Number(f.seen.chance) };
    const deep = {};
    if (s(f.history)) deep.history = s(f.history);
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
    const base = String(name ?? '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'npc';
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
        if (!s(e.place)) p[`schedule.${i}.place`] = 'Choose a place on the map.';
        else if (places && !places.has(s(e.place))) p[`schedule.${i}.place`] = `${e.place} is not in this world. Choose another place.`;
        if (!s(e.activity)) p[`schedule.${i}.activity`] = 'What are they doing there?';
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
/** The in-play summary rows for one person: [label, text]. */
export function playSummary(play, placeName = a => a) {
    if (!play) return [];
    const rows = [];
    const pos = play.position;
    rows.push(['Where', pos?.place ? `${placeName(pos.place)}${pos.activity ? ` (${pos.activity})` : ''}` : 'off the map right now']);
    rows.push(['Status', play.following ? `following ${play.following.who === 'player' ? 'you' : play.following.who}` : play.held ? `staying at ${placeName(play.held.place)}` : KIND[pos?.kind] ?? 'on their own schedule']);
    if (play.present) rows.push(['Scene', 'in your scene now']);
    const d = play.disposition?.player;
    rows.push(['Toward you', d ? `${d.value}${d.reason ? ` (${d.reason})` : ''}` : 'unknown']);
    if (play.memory?.length) rows.push(['Remembers', play.memory.slice(-3).join('; ')]);
    return rows;
}
/** The in-play changes list: [{msg, type, text, off}], oldest first. */
export const stampRows = play => (play?.stamps ?? []).filter(x => x.type !== 'npc_decline').map(x => ({ msg: x.msg, type: x.type, text: x.summary, off: !!x.off }));

// ---- Diffs on submit, and "In this chat" edits as stamps.
const show = v => (v === undefined || v === null || v === '' ? '' : typeof v === 'string' ? v : JSON.stringify(v));
/** Field-by-field changes between two cast records: [{field, from, to}]. */
export function recordChanges(a = {}, b = {}) {
    const out = [];
    const keys = [...new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})])].filter(k => k !== 'raw' && k !== 'ok' && k !== 'file' && k !== 'problems');
    for (const k of keys) if (JSON.stringify(a?.[k] ?? null) !== JSON.stringify(b?.[k] ?? null)) out.push({ field: k, from: show(a?.[k]), to: show(b?.[k]) });
    return out;
}
/** A form for "In this chat": the person as the chat has them now (their folded state, not the cast file). */
export function formFromPlay(play) {
    const f = formFromRecord(play?.record ?? play ?? {});
    const d = play?.disposition?.player;
    if (d) { f.disposition = d.value === 'unknown' ? '' : d.value ?? ''; f.reason = d.reason ?? ''; }
    return f;
}
/**
 * The stamps that make the chat match the form: changed line / manner / voice / history, new facts, secrets, relationships
 * and memories, and a disposition change (dramatic, so it may jump the ladder). Removals cannot be stamped; they are reported.
 */
export function chatStamps(play, f) {
    const base = formFromPlay(play);
    const stamps = [], cannot = [];
    for (const k of ['line', 'manner', 'voice', 'appearance']) if (s(f[k]) !== s(base[k])) { if (s(f[k])) stamps.push({ type: 'npc_fact', field: k, text: s(f[k]) }); else cannot.push(`clear ${k}`); }
    if (s(f.history) !== s(base.history)) { if (s(f.history)) stamps.push({ type: 'npc_fact', field: 'deep.history', text: s(f.history) }); else cannot.push('clear history'); }
    const added = (now, was) => now.map(s).filter(Boolean).filter(x => !was.map(s).includes(x));
    const removed = (now, was) => was.map(s).filter(Boolean).filter(x => !now.map(s).includes(x));
    for (const t of added(f.facts ?? [], base.facts)) stamps.push({ type: 'npc_fact', field: 'fact', text: t });
    for (const t of added(f.secrets ?? [], base.secrets)) stamps.push({ type: 'npc_fact', field: 'deep.secrets', text: t });
    for (const t of added(f.memory ?? [], base.memory)) stamps.push({ type: 'npc_memory', note: t });
    for (const r of f.relationships ?? []) { const was = base.relationships.find(x => x.who === s(r.who)); if (s(r.who) && s(r.text) && s(was?.text) !== s(r.text)) stamps.push({ type: 'npc_fact', field: `deep.relationships.${s(r.who)}`, text: s(r.text) }); }
    for (const [k, list] of [['facts', 'fact'], ['memory', 'memory'], ['secrets', 'secret']]) for (const t of removed(f[k] ?? [], base[k])) cannot.push(`remove ${list} "${t}" (turn its stamp off in the chat instead)`);
    if (s(f.disposition) !== s(base.disposition) || (s(f.disposition) && s(f.reason) !== s(base.reason))) {
        if (s(f.disposition)) stamps.push({ type: 'npc_disposition', who: 'player', value: s(f.disposition), reason: s(f.reason), dramatic: true });
        else cannot.push('set disposition back to unknown');
    }
    return { stamps, cannot };
}
const stampText = x => (x.type === 'npc_memory' ? `memory: ${x.note}` : x.type === 'npc_disposition' ? `toward the player: ${x.value}${x.reason ? ` (${x.reason})` : ''}` : `${x.field === 'fact' ? 'fact' : x.field}: ${x.text}`);
export const chatStampLines = stamps => stamps.map(stampText);

/** Inspector rows for one person: [label, text], from npcPlayState's `why`. */
export function whyRows(play, placeName = a => a) {
    const w = play?.why;
    if (!w) return [];
    const pad = n => String(n ?? 0).padStart(2, '0');
    const rows = [];
    if (w.clock) rows.push(['Game time', `day ${w.clock.day}, ${pad(w.clock.hour)}:${pad(w.clock.minute)}`]);
    rows.push(['Where', w.place ? `${placeName(w.place)}${play.position?.activity ? ` (${play.position.activity})` : ''}` : 'nowhere this hour']);
    rows.push(['Why', w.reason || '']);
    rows.push(['Record', `${w.tier}${w.from === 'play' ? ', created in this chat' : ', from the cast file'}`]);
    rows.push(['Following', w.following ? (w.following.who === 'player' ? 'the player' : w.following.who) : 'no']);
    if (w.held) rows.push(['Staying', `${placeName(w.held.place)} (since #${w.held.at}${w.held.active ? ', still holding' : ', hold over'})`]);
    if (w.schedule) rows.push(['Schedule', w.schedule.entry >= 0 ? `entry ${w.schedule.entry + 1}: ${w.schedule.activity || ''} at ${placeName(w.schedule.address)}${w.schedule.how && w.schedule.how !== 'exact' ? ` (${w.schedule.how})` : ''}. ${w.schedule.why}` : w.schedule.why]);
    if (w.sighting) {
        const g = w.sighting;
        rows.push(['Sighting', g.active ? `${placeName(g.resolved)} around ${g.hour}:00, peak ${Math.round(g.chance * 100)}%. Today (day ${g.day}): chance now ${g.now}, roll ${g.roll}${g.seekRoll != null ? `, by-name roll ${g.seekRoll}` : ''} → ${g.wouldShow ? 'shows' : 'no-show'}${g.stamped ? ' (appearance stamped)' : ''}` : `${g.place}: ${g.note}`]);
    }
    rows.push(['Toward the player', `${w.disposition?.value ?? 'unknown'}${w.disposition?.reason ? ` (${w.disposition.reason})` : ''}`]);
    rows.push(['Memory', w.memory?.length ? w.memory.join('; ') : '(none)']);
    if (w.declined) rows.push(['Scene', 'a "no" to remembering them was said in this scene']);
    return rows;
}
