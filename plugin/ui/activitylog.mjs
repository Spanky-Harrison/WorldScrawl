// The map window's per-message activity log (read-only). Entries come from the extension (extension/activity.mjs);
// each kind can register its own renderer: registerRenderer(kind, (entry, $) -> Node | string).
const renderers = new Map();
export function registerRenderer(kind, fn) { renderers.set(kind, fn); }
export const KIND_LABEL = { flag: 'Flags', roll: 'Rolls', map: 'Map stamps', position: 'Positions', npc: 'People', clock: 'Clock', card: 'Cards', focus: 'Narrator', scene: 'Scene', call: 'Model calls' };
const fallback = (e, $) => $('span', {}, $('b', {}, e.label ?? e.kind), e.text ? `: ${e.text}` : '', e.status ? ` [${e.status}]` : '', e.swipe != null ? ` (swipe ${e.swipe})` : '');
registerRenderer('roll', (e, $) => $('span', {}, $('b', {}, e.label), `: rolled ${e.roll} vs ${e.chance}% → ${e.present ? 'shows' : 'no-show'}${e.seekRoll != null ? ` (by-name roll ${e.seekRoll})` : ''}`));
registerRenderer('call', (e, $) => $('span', { class: e.status === 'ok' ? '' : 'bad' }, $('b', {}, e.label ?? 'call'), `: ${e.status ?? 'skipped'}${e.tries > 1 ? ` after ${e.tries} tries` : ''}${e.reason ? ` — ${e.reason}` : ''}${e.answer ? ` (answer: ${e.answer})` : ''}`));
export function renderEntry(e, $) { const r = renderers.get(e.kind) ?? fallback; try { return r(e, $); } catch { return fallback(e, $); } }
/** Group entries by kind, in KIND_LABEL order then any new kinds. */
export function groupEntries(entries) {
    const g = new Map();
    for (const e of entries ?? []) { const k = KIND_LABEL[e.kind] ? e.kind : e.kind ?? 'other'; if (!g.has(k)) g.set(k, []); g.get(k).push(e); }
    const order = [...Object.keys(KIND_LABEL), ...[...g.keys()].filter(k => !KIND_LABEL[k])];
    return order.filter(k => g.has(k)).map(k => ({ kind: k, title: KIND_LABEL[k] ?? k, entries: g.get(k) }));
}
