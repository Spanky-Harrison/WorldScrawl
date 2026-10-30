// Cast files: worlds/<world>/cast/<id>.json, one NPC each. A bad file or a bad entry is recorded
// and skipped. The world still loads.
import fs from 'node:fs';
import path from 'node:path';
import { NPC_ID, exportRecord, freeId, nameIn, validateRecord } from './npc.mjs';
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

/** Place notes or descriptions that name a cast person: the narrator may portray them there off-shift. */
export function castNameWarnings(world, npcs) {
    const out = [];
    const groups = [['region', world?.regions], ['subregion', world?.subregions], ['place', world?.locations]];
    for (const n of npcs ?? []) {
        if (!n?.ok || !n.name) continue;
        for (const [, map] of groups) for (const [key, r] of map?.entries?.() ?? []) {
            const fields = ['notes', 'description'].filter(f => typeof r?.[f] === 'string' && nameIn(r[f], n.name));
            if (fields.length) out.push(`${r.name ?? key} ${fields.join(' and ')} mention${fields.length > 1 ? "" : "s"} cast NPC ${n.name} by name; the narrator may portray ${n.name} off-shift. Keep their details in the cast file.`);
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
