import { CALLS_KEY, callNotes } from './calllog.mjs';
// The per-message activity log (read-only): what the engine and the narrator did on one message, rebuilt from the data
// already on it (message.extra) including the model-call notes (extension/calllog.mjs), which persist with the chat.
// New kinds plug in with registerActivity(extraKey, collect); the map window draws each entry with its own renderer
// (plugin/ui/activitylog.mjs registerRenderer), falling back to the entry's label and text.
const short = (v, n = 240) => { const t = typeof v === 'string' ? v : JSON.stringify(v); return t && t.length > n ? `${t.slice(0, n - 1)}…` : t ?? ''; };
const list = v => (Array.isArray(v) ? v : v == null ? [] : [v]);
const collectors = new Map();
/** collect(value, msg, index) -> entry or entries: {kind, label, text, status?, swipe?}. */
export function registerActivity(key, collect) { collectors.set(key, collect); }

registerActivity('worldscrawl_flag', v => list(v).map(f => ({ kind: 'flag', label: `ws_flag ${f?.kind ?? f?.action ?? ''}`.trim(), text: [f?.hint, f?.note].filter(Boolean).join(' — ') || short(f), status: f?.status ?? f?.outcome ?? null, source: f?.source ?? null })));
registerActivity('worldscrawl_flaghint', v => ({ kind: 'flag', label: 'flag hint sent', text: short(v) }));
registerActivity('worldscrawl_patches', v => list(v).map(p => ({ kind: 'map', label: `map change${p?.type ? ` (${p.type})` : ''}`, text: p?.summary ?? p?.title ?? short(p?.ops ?? p), status: p?.status ?? (p?.off ? 'off' : null), swipe: p?.swipe ?? null })));
registerActivity('worldscrawl_change', v => list(v).map(c => ({ kind: 'map', label: `door / map stamp${c?.type ? ` (${c.type})` : ''}`, text: short(c) })));
registerActivity('worldscrawl_move', v => ({ kind: 'position', label: 'player moved', text: [v?.from, v?.direction ?? v?.dir, v?.to ?? v?.address].filter(Boolean).join(' → ') || short(v) }));
registerActivity('worldscrawl_location', v => ({ kind: 'position', label: 'location stamped', text: v?.address ?? short(v) }));
registerActivity('worldscrawl_actors', v => ({ kind: 'position', label: 'actor positions', text: short(v) }));
registerActivity('worldscrawl_wait', v => ({ kind: 'clock', label: v?.sleep ? 'slept' : 'waited', text: `${v?.label ?? ''}${v?.seconds ? ` (${v.seconds}s)` : ''}`.trim() }));
registerActivity('worldscrawl_waitcard', v => ({ kind: 'card', label: 'wait card', text: short(v?.label ?? v), status: v?.status ?? null }));
registerActivity('worldscrawl_remember', v => ({ kind: 'card', label: `Remember card${v?.suggested ? ' (suggested)' : ''}`, text: v?.name ?? '', status: v?.status ?? null }));
registerActivity('worldscrawl_npc_flags', v => list(v).flatMap(f => list(f?.names).map(n => ({ kind: 'npc', label: 'ws_flag npc (person flagged)', text: n, swipe: f?.swipe ?? null }))));
registerActivity('worldscrawl_focus', v => ({ kind: 'focus', label: 'narrator focus', text: v?.id ? `${v.id} (${v.depth ?? 'present'})` : 'nobody' }));
registerActivity('worldscrawl_npc', v => list(v).map(s => ({ kind: 'npc', label: s?.type ?? 'npc', text: s?.summary ?? [s?.id, s?.text ?? s?.note ?? s?.value ?? s?.place ?? s?.name].filter(Boolean).join(': '), status: s?.off ? 'off' : null, swipe: s?.swipe ?? null })));
registerActivity('worldscrawl_reveal', v => ({ kind: 'map', label: 'revealed', text: short(v) }));
registerActivity('worldscrawl_scene', v => ({ kind: 'scene', label: 'scene', text: short(v) }));
const QUIET = new Set(['worldscrawl_enabled', 'worldscrawl_notice', 'worldscrawl_notice_kind']);

registerActivity(CALLS_KEY, (v, msg) => callNotes(msg).map(n => ({ kind: 'call', label: n.kind, status: n.status, reason: n.reason ?? (n.emitted ? `emitted ${n.emitted.join(', ')}` : ''), tries: n.tries ?? 1, answer: n.answer ?? null })));

/** Every entry for message `index`, plus `extra` entries (rolls computed by the caller). */
export function messageActivity(msg, index, { extra = [] } = {}) {
    const out = [];
    for (const [key, val] of Object.entries(msg?.extra ?? {})) {
        if (QUIET.has(key) || val == null) continue;
        const c = collectors.get(key);
        if (c) { try { out.push(...list(c(val, msg, index))); } catch (e) { out.push({ kind: key, label: key, text: `(could not read: ${e.message})` }); } }
        else if (key.startsWith('worldscrawl_')) out.push({ kind: key, label: key.slice(12), text: short(val) });
    }
    out.push(...extra);
    return out.filter(Boolean);
}
