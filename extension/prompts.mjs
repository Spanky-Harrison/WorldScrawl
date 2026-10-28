// Copy of plugin/ui/prompts.mjs (the extension cannot import plugin files statically). Keep them the same; a test checks.
// Prompt text for every model call. The text lives in plugin/prompts/default.json (layered with the selected profile's
// overrides on the server); code only fills in {{placeholders}}. render() never re-reads what it put in.
let current = null;
/** Set the prompts: a {id: text} map, or the {prompts: [...]} file. */
export function setPrompts(p) {
    current = Array.isArray(p?.prompts) ? Object.fromEntries(p.prompts.map(e => [e.id, e.text])) : { ...p };
    return current;
}
export const hasPrompts = () => current != null;
export const promptText = id => {
    if (!current) throw new Error('WorldScrawl prompts are not loaded yet');
    if (typeof current[id] !== 'string') throw new Error(`WorldScrawl prompt "${id}" is missing`);
    return current[id];
};
/** Fill {{name}} placeholders in one pass. An unknown name is left as it is. */
export const fill = (text, vars = {}) => String(text).replace(/\{\{(\w+)\}\}/g, (m, k) => (Object.prototype.hasOwnProperty.call(vars, k) && vars[k] != null ? String(vars[k]) : m));
/** {{who}} is the old name of {{party}}: saved profiles that still use it keep working. */
const withAliases = vars => (vars && 'party' in vars && !('who' in vars) ? { ...vars, who: vars.party } : vars);
export const render = (id, vars = {}) => fill(promptText(id), withAliases(vars));
/** The placeholder names used in a text. */
export const placeholdersIn = text => [...new Set([...String(text).matchAll(/\{\{(\w+)\}\}/g)].map(m => m[1]))];
/** Fetch the active (default + selected profile) prompts from the plugin. */
export async function loadPrompts(base = '/api/plugins/worldscrawl') {
    const r = await fetch(`${base}/prompts/active`);
    if (!r.ok) throw new Error(`prompts: server answered ${r.status}`);
    return setPrompts((await r.json()).prompts);
}
