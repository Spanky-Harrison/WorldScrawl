// Prompt profiles, stored per SillyTavern user in <user data>/worldscrawl/prompts.json:
//   { "selected": "My profile", "profiles": { "My profile": { "overrides": { "<prompt id>": { "text", "base_hash", "base_text" } } } } }
// A profile keeps only its overrides; plugin/prompts/default.json is never changed. "Default" is the built-in, read-only profile.
// Each override remembers the default text it was based on, so the editor can say "the default changed since you edited this".
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_FILE = path.join(here, 'prompts', 'default.json');
export const DEFAULT_PROFILE = 'Default';
export const hashText = t => crypto.createHash('sha256').update(String(t)).digest('hex').slice(0, 16);
let cache = null;
export function loadDefault(file = DEFAULT_FILE) {
    const st = fs.statSync(file);
    if (!cache || cache.file !== file || cache.mtime !== st.mtimeMs) cache = { file, mtime: st.mtimeMs, data: JSON.parse(fs.readFileSync(file, 'utf8')) };
    return cache.data;
}
export const storeFile = root => path.join(root, 'worldscrawl', 'prompts.json');
export function readStore(root) {
    try {
        const s = JSON.parse(fs.readFileSync(storeFile(root), 'utf8'));
        return { selected: typeof s.selected === 'string' ? s.selected : DEFAULT_PROFILE, profiles: s.profiles && typeof s.profiles === 'object' ? s.profiles : {} };
    } catch { return { selected: DEFAULT_PROFILE, profiles: {} }; }
}
export function writeStore(root, s) {
    const f = storeFile(root);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f + '.tmp', JSON.stringify(s, null, 2) + '\n');
    fs.renameSync(f + '.tmp', f);
}
const bad = detail => ({ status: 400, body: { detail } });
const ok = body => ({ status: 200, body });
function checkName(s, name) {
    if (typeof name !== 'string' || !name.trim()) return 'give the profile a name';
    name = name.trim();
    if (name.length > 60) return 'that name is too long (60 characters at most)';
    if (name.toLowerCase() === DEFAULT_PROFILE.toLowerCase()) return '"Default" is the built-in profile; pick another name';
    if (Object.keys(s.profiles).some(n => n.toLowerCase() === name.toLowerCase())) return `there is already a profile called "${name}"`;
    return null;
}
/** The prompts in use: the default text, with the selected profile's overrides on top. */
export function activePrompts(def, s) {
    const prof = s.profiles[s.selected];
    const ov = prof?.overrides ?? {};
    return Object.fromEntries(def.prompts.map(e => [e.id, typeof ov[e.id]?.text === 'string' ? ov[e.id].text : e.text]));
}
/** Everything the editor needs: the default entries, the profiles, and for each override whether the default moved on. */
export function editorState(def, s) {
    const byId = Object.fromEntries(def.prompts.map(e => [e.id, e]));
    const profiles = Object.fromEntries(Object.entries(s.profiles).map(([name, p]) => [name, { overrides: Object.fromEntries(Object.entries(p.overrides ?? {})
        .filter(([id]) => byId[id]).map(([id, o]) => [id, { ...o, default_changed: !!o.base_hash && o.base_hash !== hashText(byId[id].text) }])) }]));
    return { selected: s.profiles[s.selected] ? s.selected : DEFAULT_PROFILE, default_profile: DEFAULT_PROFILE, prompts: def.prompts, profiles };
}
/** Framework-free handler for /prompts routes. Returns null for any other path. */
export function handlePrompts(method, url, body, root, defFile = DEFAULT_FILE) {
    const p = String(url).split('?')[0].replace(/\/+$/, '');
    if (!p.startsWith('/prompts')) return null;
    const def = loadDefault(defFile), s = readStore(root);
    if (!s.profiles[s.selected]) s.selected = DEFAULT_PROFILE;
    if (method === 'GET' && p === '/prompts/active') return ok({ profile: s.selected, prompts: activePrompts(def, s) });
    if (method === 'GET' && p === '/prompts') return ok(editorState(def, s));
    if (method !== 'POST') return { status: 404, body: { detail: 'not found' } };
    const b = body ?? {};
    const done = () => { writeStore(root, s); return ok(editorState(def, s)); };
    if (p === '/prompts/select') {
        if (b.profile !== DEFAULT_PROFILE && !s.profiles[b.profile]) return bad(`no profile called "${b.profile}"`);
        s.selected = b.profile; return done();
    }
    if (p === '/prompts/profile') {
        const { action } = b;
        if (action === 'new' || action === 'duplicate') {
            const e = checkName(s, b.name); if (e) return bad(e);
            const from = action === 'duplicate' ? b.from : null;
            if (from && from !== DEFAULT_PROFILE && !s.profiles[from]) return bad(`no profile called "${from}"`);
            s.profiles[b.name.trim()] = { overrides: structuredClone(from && s.profiles[from] ? s.profiles[from].overrides ?? {} : {}) };
            s.selected = b.name.trim(); return done();
        }
        if (action === 'rename') {
            if (!s.profiles[b.from]) return bad(b.from === DEFAULT_PROFILE ? 'the Default profile cannot be renamed' : `no profile called "${b.from}"`);
            const e = checkName({ profiles: Object.fromEntries(Object.entries(s.profiles).filter(([n]) => n !== b.from)) }, b.name); if (e) return bad(e);
            const to = b.name.trim();
            s.profiles = Object.fromEntries(Object.entries(s.profiles).map(([n, v]) => [n === b.from ? to : n, v]));
            if (s.selected === b.from) s.selected = to;
            return done();
        }
        if (action === 'delete') {
            if (!s.profiles[b.name]) return bad(b.name === DEFAULT_PROFILE ? 'the Default profile cannot be deleted' : `no profile called "${b.name}"`);
            delete s.profiles[b.name];
            if (s.selected === b.name) s.selected = DEFAULT_PROFILE;
            return done();
        }
        return bad('action must be new, duplicate, rename or delete');
    }
    if (p === '/prompts/override' || p === '/prompts/reset') {
        if (b.profile === DEFAULT_PROFILE || !s.profiles[b.profile]) return bad(b.profile === DEFAULT_PROFILE ? 'the Default profile is read-only: make a new profile first' : `no profile called "${b.profile}"`);
        const entry = def.prompts.find(e => e.id === b.id);
        if (!entry) return bad(`no prompt called "${b.id}"`);
        const ov = s.profiles[b.profile].overrides ??= {};
        if (p === '/prompts/reset') { delete ov[b.id]; return done(); }
        if (typeof b.text !== 'string') return bad('text must be a string');
        if (b.text === entry.text) delete ov[b.id]; // same as the default: nothing to keep
        else ov[b.id] = { text: b.text, base_hash: hashText(entry.text), base_text: entry.text };
        return done();
    }
    return { status: 404, body: { detail: 'not found' } };
}
