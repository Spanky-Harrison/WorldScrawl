// Cast files: worlds/<world>/cast/<id>.json, one NPC each. A bad file or a bad entry is recorded
// and skipped. The world still loads.
import fs from 'node:fs';
import path from 'node:path';
import { NPC_ID, NPC_TOKEN, exportRecord, freeId, nameIn, npcTokenIds, validateRecord } from './npc.mjs';
import { isDir, isFile, isObj, loadJson } from './world.mjs';

export function castFiles(root) {
    const dir = path.join(root, 'cast');
    if (!isDir(dir)) return [];
    return fs.readdirSync(dir).filter(n => n.endsWith('.json') && isFile(path.join(dir, n))).sort().map(n => path.join(dir, n));
}

/** Names and addresses the cast is checked against. */
export function worldPlaces(world) {
    const addresses = new Set(world?.locations?.keys?.() ?? []);
    const names = [];
    const labels = {};
    for (const r of world?.regions?.values?.() ?? []) if (r?.name) names.push(r.name);
    for (const s of world?.subregions?.values?.() ?? []) if (s?.name) names.push(s.name);
    for (const l of world?.locations?.values?.() ?? []) {
        if (l?.name) names.push(l.name);
        if (l?.address && l?.name) labels[l.address] = l.name;
    }
    return { addresses, names: [...new Set(names)], labels };
}

/**
 * Load warnings for place text (lore and descriptions): a cast name or alias written as plain text ("did you mean
 * {{npc:hesk}}?"), and a {{npc:id}} token whose id is not in the cast. Aliases come from the cast file's "aliases" list.
 */
export function castNameWarnings(world, npcs) {
    const out = [];
    const ok = (npcs ?? []).filter(n => n?.ok && n.id);
    const ids = new Set(ok.map(n => String(n.id).toLowerCase()));
    const groups = [world?.regions, world?.subregions, world?.locations];
    for (const map of groups) for (const [key, r] of map?.entries?.() ?? []) {
        for (const [f, label] of [['notes', 'lore'], ['description', 'description']]) {
            const text = typeof r?.[f] === 'string' ? r[f] : '';
            if (!text) continue;
            const plain = text.replace(NPC_TOKEN, ' ');
            for (const n of ok) {
                const names = [n.name, ...(Array.isArray(n.raw?.aliases) ? n.raw.aliases : [])].filter(a => typeof a === 'string' && a.trim());
                const hit = names.find(a => nameIn(plain, a));
                if (hit) out.push(`${r.name ?? key} ${label} names cast NPC ${hit} in plain text; did you mean {{npc:${n.id}}}?`);
            }
            for (const id of npcTokenIds(text)) if (!ids.has(id)) out.push(`${r.name ?? key} ${label} has {{npc:${id}}}, but no cast NPC has the id "${id}"; it shows as "${id || 'someone'}".`);
        }
    }
    return out;
}

/**
 * Load every cast file. Never throws. `npcs` includes broken records (ok: false) so an editor can show them.
 * Play uses only ok records.
 */
export function loadCast(root, world = null) {
    const problems = [];
    const npcs = [];
    const seen = new Set();
    const { addresses, names } = worldPlaces(world);
    let files = [];
    try { files = castFiles(root); } catch (e) { return { npcs, problems: [`cast: ${e.message}`], names }; }
    for (const file of files) {
        const base = path.basename(file);
        let raw;
        try { raw = loadJson(file); } catch (e) { problems.push(e.message); continue; }
        if (!isObj(raw)) { problems.push(`${base}: not an object`); continue; }
        const rec = validateRecord(raw, { file: base, places: addresses });
        rec.file = base;
        rec.raw = raw;
        if (rec.id && seen.has(rec.id)) {
            const prev = npcs.find(n => n.id === rec.id && n.ok);
            const prevMatch = prev?.file === `${rec.id}.json`;
            if (prev && !prevMatch && base === `${rec.id}.json`) {
                prev.ok = false;
                prev.problems = [...prev.problems, `${prev.file}: duplicate id ${rec.id}`];
            } else {
                rec.ok = false;
                rec.problems = [...rec.problems, `${base}: duplicate id ${rec.id}`];
            }
        }
        if (rec.id && rec.ok) seen.add(rec.id);
        for (const p of rec.problems) if (!problems.includes(p)) problems.push(p);
        npcs.push(rec);
    }
    if (world) for (const w of castNameWarnings(world, npcs)) problems.push(w);
    return { npcs, problems, names };
}

/**
 * Write one NPC into cast/.
 * `update` overwrites the file that already has this same id (a person who came from that cast file).
 * Otherwise an id that is already taken gets a new id (`id-2`), and the old file is kept.
 * Returns the record that was written (re-validated). Throws when the record itself is not usable.
 */
export function writeCastNpc(root, npc, { update = false } = {}) {
    const record = exportRecord(npc) ?? (isObj(npc) ? npc : null);
    if (!record) throw new Error('nothing to export');
    const taken = new Set();
    const byId = new Map();
    const dir = path.join(root, 'cast');
    fs.mkdirSync(dir, { recursive: true });
    for (const f of castFiles(root)) {
        const base = path.basename(f, '.json');
        taken.add(base);
        try {
            const raw = loadJson(f);
            if (isObj(raw) && typeof raw.id === 'string') {
                taken.add(raw.id);
                if (!byId.has(raw.id)) byId.set(raw.id, f);
            }
        } catch { /* a broken file still occupies its name */ }
    }
    let id = NPC_ID.test(record.id ?? '') ? record.id : freeId(record.name, taken);
    const existing = byId.get(id);
    const updated = !!(update && existing);
    if (!updated && taken.has(id)) id = freeId(id, taken);
    const out = { ...record, id };
    const checked = validateRecord(out, { file: `${id}.json`, places: null });
    if (!checked.ok) throw new Error(checked.problems.join('; ') || 'the NPC record is not valid');
    const file = updated ? existing : path.join(dir, `${id}.json`);
    fs.writeFileSync(file, JSON.stringify(out, null, 2) + '\n');
    return { id, file: path.basename(file), renamed: id !== record.id, updated, record: out };
}

/** Cast file names and the ids inside them: {byId: Map id -> file, taken: Set of ids and file bases}. */
function castIndex(root) {
    const taken = new Set(), byId = new Map();
    for (const f of castFiles(root)) {
        taken.add(path.basename(f, '.json'));
        try {
            const raw = loadJson(f);
            if (isObj(raw) && typeof raw.id === 'string') { taken.add(raw.id); if (!byId.has(raw.id)) byId.set(raw.id, f); }
        } catch { /* a broken file still occupies its name */ }
    }
    return { taken, byId };
}

const castFile = (root, name) => {
    const base = typeof name === 'string' ? path.basename(name) : '';
    if (!base || base !== name || !base.endsWith('.json')) return null;
    const f = path.join(root, 'cast', base);
    return isFile(f) ? f : null;
};

/** Drop empty fields so an editor save writes a tidy cast file (the same shape as a hand-written one). */
export function tidyRecord(raw) {
    const out = {};
    const s = v => (typeof v === 'string' ? v.trim() : '');
    for (const k of ['id', 'name', 'line', 'manner', 'voice']) if (s(raw[k])) out[k] = s(raw[k]);
    const deep = {};
    if (isObj(raw.deep)) {
        if (s(raw.deep.history)) deep.history = s(raw.deep.history);
        const secrets = Array.isArray(raw.deep.secrets) ? raw.deep.secrets.map(s).filter(Boolean) : [];
        if (secrets.length) deep.secrets = secrets;
        const rel = {};
        if (isObj(raw.deep.relationships)) for (const [k, v] of Object.entries(raw.deep.relationships)) if (s(k) && s(v)) rel[s(k)] = s(v);
        if (Object.keys(rel).length) deep.relationships = rel;
    }
    if (Object.keys(deep).length) out.deep = deep;
    for (const k of ['facts', 'memory']) { const l = Array.isArray(raw[k]) ? raw[k].map(s).filter(Boolean) : []; if (l.length) out[k] = l; }
    if (isObj(raw.disposition)) {
        const d = {};
        for (const [who, row] of Object.entries(raw.disposition)) if (isObj(row) && s(row.value)) d[who] = { value: s(row.value), ...(s(row.reason) ? { reason: s(row.reason) } : {}) };
        if (Object.keys(d).length) out.disposition = d;
    }
    if (Array.isArray(raw.schedule)) {
        const sched = raw.schedule.filter(isObj).map(e => {
            const x = { place: s(e.place), activity: s(e.activity) };
            if (s(e.from)) x.from = s(e.from);
            if (s(e.to)) x.to = s(e.to);
            if (s(e.importance)) x.importance = s(e.importance);
            return x;
        });
        if (sched.length) out.schedule = sched;
    }
    if (isObj(raw.seen_at) && s(raw.seen_at.place)) out.seen_at = { place: s(raw.seen_at.place), hour: raw.seen_at.hour, chance: raw.seen_at.chance ?? 0.5 };
    return out;
}

/**
 * Save one NPC from the cast editor. `original` is the id (or file name, for a broken file) being edited; null creates.
 * The id must be free (other than the NPC's own), the record must validate, and every place must be in this world.
 * A rename writes <new id>.json and removes the old file. Returns {id, file, record}.
 */
export function saveCastNpc(root, raw, { original = null, originalFile = null, places = null } = {}) {
    if (!isObj(raw)) throw new Error('nothing to save');
    const record = tidyRecord(raw);
    if (!NPC_ID.test(record.id ?? '')) throw new Error('id must be a short slug: lowercase letters, digits, - or _');
    const { taken, byId } = castIndex(root);
    const oldFile = (originalFile && castFile(root, originalFile)) || (original ? byId.get(original) ?? null : null);
    if (original && !oldFile) throw new Error(`no cast file for ${original}`);
    const ownBase = oldFile ? path.basename(oldFile, '.json') : null;
    if (record.id !== original && taken.has(record.id) && record.id !== ownBase) throw new Error(`id ${record.id} is already taken`);
    const checked = validateRecord(record, { file: `${record.id}.json`, places });
    const problems = checked.problems;
    if (!checked.ok || problems.length) throw new Error(problems.join('; ') || 'the NPC record is not valid');
    const dir = path.join(root, 'cast');
    fs.mkdirSync(dir, { recursive: true });
    const keepName = oldFile && (path.basename(oldFile) === `${record.id}.json` || record.id === original);
    const file = keepName ? oldFile : path.join(dir, `${record.id}.json`);
    fs.writeFileSync(file, JSON.stringify(record, null, 2) + '\n');
    if (oldFile && oldFile !== file) fs.rmSync(oldFile);
    return { id: record.id, file: path.basename(file), record };
}

/** Delete one cast file, by the id inside it or (for a broken file) by its file name. */
export function deleteCastNpc(root, { id = null, file = null } = {}) {
    const f = (file && castFile(root, file)) || (id ? castIndex(root).byId.get(id) ?? null : null);
    if (!f) throw new Error(`no cast file for ${id ?? file}`);
    fs.rmSync(f);
    return { file: path.basename(f) };
}
