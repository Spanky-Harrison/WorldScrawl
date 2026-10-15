// WorldScrawl: engine-driven movement on the WorldScrawl map server. The engine (this extension) owns
// the party's location; the model only interprets what the player meant (one multiple-choice question)
// and narrates. Optional, off by default: the old ws_look/ws_move tools.
// The party's location is stored on chat messages (message.extra.worldscrawl_location) so that
// deleting or swiping messages rolls the location back with them.
const MODULE = 'worldscrawl';
const LOC_KEY = 'worldscrawl_location';
const DEFAULT_NUDGE = 'The world map is tracked by tools. Before describing where the characters are or where they can go, call ws_look. Whenever the characters travel through an exit, call ws_move with that exit\'s direction, then describe the new location from the tool result. Do not invent locations or exits that the tools did not return.';
const DEFAULTS = { serverUrl: 'http://127.0.0.1:5100', nudge: DEFAULT_NUDGE, showExits: true, moveMode: 'typed' };
const MODES = ['commands', 'typed', 'tools'];
const MOVE_KEY = 'worldscrawl_move'; // {direction, from, from_name, to, to_name} on the message that moved
const FACTS_KEY = 'worldscrawl_facts';
const TOOL_NAMES = ['ws_look', 'ws_move'];
const NUDGE_KEY = 'worldscrawl_nudge';

const ctx = () => SillyTavern.getContext();
const toolsOn = () => settings().moveMode === 'tools';
let pendingLocation = null;

export function settings() {
    const all = ctx().extensionSettings;
    const saved = all[MODULE] ?? {};
    if (!MODES.includes(saved.moveMode)) { // migrate the old v0.2 checkboxes
        saved.moveMode = saved.useTools ? 'tools' : saved.parseIntent === false ? 'commands' : 'typed';
    }
    delete saved.useTools; delete saved.parseIntent;
    all[MODULE] = Object.assign({}, DEFAULTS, saved);
    return all[MODULE];
}

const baseUrl = () => String(settings().serverUrl || DEFAULTS.serverUrl).replace(/\/+$/, '');

async function api(path, options = {}) {
    let res;
    try {
        res = await fetch(baseUrl() + path, { ...options, headers: { 'Content-Type': 'application/json', ...(options.headers ?? {}) } });
    } catch (e) {
        throw new Error(`WorldScrawl server not reachable at ${baseUrl()} (${e.message}). Is it running?`);
    }
    const body = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, body };
}

/** Latest location stored on a message, or null if this chat has none yet. */
export function getStoredLocation() {
    const chat = ctx().chat ?? [];
    for (let i = chat.length - 1; i >= 0; i--) {
        const loc = chat[i]?.extra?.[LOC_KEY];
        if (loc) return loc;
    }
    return null;
}

async function currentLocation() {
    const stored = getStoredLocation();
    if (stored) {
        const r = await api(`/location/${encodeURIComponent(stored)}`);
        if (r.ok) return r.body;
    }
    const r = await api('/start');
    if (!r.ok) throw new Error(`WorldScrawl /start failed: ${JSON.stringify(r.body)}`);
    return r.body;
}

function describe(loc) {
    return JSON.stringify({
        location: loc.name,
        address: loc.address,
        region: loc.region?.name,
        description: loc.description,
        exits: loc.exits.map(e => ({ direction: e.direction, ...(revealsDestination(e) ? { leads_to: e.to_name } : {}), ...(e.description ? { description: e.description } : {}) })),
    });
}

async function lookAction() {
    const loc = await currentLocation();
    if (!getStoredLocation()) pendingLocation = loc.address; // first look in a chat fixes the start location
    return describe(loc);
}

async function moveAction({ direction } = {}) {
    if (!direction) return JSON.stringify({ error: 'direction is required' });
    const from = (await currentLocation()).address;
    const r = await api('/move', { method: 'POST', body: JSON.stringify({ from, direction }) });
    if (!r.ok) {
        const d = r.body?.detail ?? {};
        return JSON.stringify({ error: d.error ?? `Move failed (${r.status})`, valid_directions: d.valid_directions ?? [] });
    }
    pendingLocation = r.body.address;
    return describe(r.body);
}

function stampLocation() {
    if (!pendingLocation) return;
    const chat = ctx().chat;
    const msg = chat?.[chat.length - 1];
    if (msg) {
        msg.extra = msg.extra ?? {};
        msg.extra[LOC_KEY] = pendingLocation;
    }
    pendingLocation = null;
}

function applyTools() {
    const c = ctx();
    if (!toolsOn()) { TOOL_NAMES.forEach(n => { try { c.unregisterFunctionTool(n); } catch {} }); return; }
    registerTools();
}

function registerTools() {
    const { registerFunctionTool } = ctx();
    registerFunctionTool({
        name: 'ws_look',
        displayName: 'WorldScrawl: Look',
        description: 'Get the party\'s current location in the world map: its name, description and the exits leading out of it. Use this before describing where the characters are or where they can go.',
        parameters: { $schema: 'http://json-schema.org/draft-04/schema#', type: 'object', properties: {}, required: [] },
        action: lookAction,
        formatMessage: () => 'Looking around...',
    });
    registerFunctionTool({
        name: 'ws_move',
        displayName: 'WorldScrawl: Move',
        description: 'Move the party through one of the current location\'s exits when the characters travel there. Returns the new location. If the direction is not valid, returns an error with the valid directions.',
        parameters: {
            $schema: 'http://json-schema.org/draft-04/schema#',
            type: 'object',
            properties: { direction: { type: 'string', description: 'The exit direction exactly as listed by ws_look, e.g. "north" or "out".' } },
            required: ['direction'],
        },
        action: moveAction,
        formatMessage: ({ direction } = {}) => `Moving ${direction ?? ''}...`,
    });
}

/** Short system note at depth 1 so the model actually uses the tools (they are ignored without it on many models). */
function applyNudge() {
    const text = toolsOn() ? String(settings().nudge ?? '').trim() : '';
    ctx().setExtensionPrompt(NUDGE_KEY, text, 1 /* IN_CHAT */, 1, false, 0 /* SYSTEM */);
}

// ---- Engine-driven movement. The engine moves the party; the model never touches the map.
let engineBusy = false;
const lastUserIndex = chat => { for (let i = chat.length - 1; i >= 0; i--) if (chat[i]?.is_user && !chat[i]?.is_system) return i; return -1; };

function stamp(msg, loc, move) {
    msg.extra = msg.extra ?? {};
    msg.extra[LOC_KEY] = loc.address;
    if (move) msg.extra[MOVE_KEY] = move;
}

/** Move through an exit of the current location. Returns {ok, to, move} or {ok:false, error, valid}. */
async function engineMove(direction) {
    const from = await currentLocation();
    const exit = from.exits.find(e => e.direction.toLowerCase() === String(direction).trim().toLowerCase());
    const r = await api('/move', { method: 'POST', body: JSON.stringify({ from: from.address, direction: String(direction).trim() }) });
    if (!r.ok) {
        const d = r.body?.detail ?? {};
        return { ok: false, error: d.error ?? `Move failed (${r.status})`, valid: d.valid_directions ?? from.exits.map(e => e.direction) };
    }
    return { ok: true, to: r.body, move: { direction: exit?.direction ?? direction, from: from.address, from_name: from.name, to: r.body.address, to_name: r.body.name } };
}

/** Normalize the model's answer and accept it only if it is exactly one of the options. */
export function parseChoice(answer, options) {
    const a = String(answer ?? '').trim().toLowerCase().replace(/^[\s"'`*_.:\-\[(]+|[\s"'`*_.:!?\])]+$/g, '');
    return options.find(o => o.toLowerCase() === a) ?? null;
}

// ---- Discovered places and route-finding (read-only map; visited set derived from this chat's messages).
/**
 * The one place that decides whether an exit reveals where it leads. Later a hidden/obscured exit
 * (e.g. exit.hidden or exit.obscured in the region file) can return false here.
 */
export const revealsDestination = exit => !(exit?.hidden || exit?.obscured);
/** Every displayed/prompted exit goes through here: "north (Village Square)", or just "north" if not revealed. */
export const exitLabel = (exit, fmt = n => ` (${n})`) => exit.direction + (revealsDestination(exit) ? fmt(exit.to_name) : '');

/** Places stood in during this chat: the start plus every location (and route step) saved on its messages. */
async function stoodInAddresses() {
    const set = new Set();
    const start = await fetchLocationCached(null);
    if (start) set.add(start.address);
    for (const m of ctx().chat ?? []) {
        const loc = m?.extra?.[LOC_KEY];
        if (loc) set.add(loc);
        for (const a of m?.extra?.[MOVE_KEY]?.via ?? []) set.add(a);
    }
    return set;
}

/** Where the party was just before arriving at `current` (from saved message locations), or null. */
export function previousAddress(current, chat = ctx().chat ?? []) {
    for (let i = chat.length - 1; i >= 0; i--) {
        const m = chat[i]?.extra;
        const mv = m?.[MOVE_KEY];
        if (mv && mv.to === current) { const via = mv.via ?? []; return via.length > 1 ? via[via.length - 2] : mv.from; }
        if (m?.[LOC_KEY] && m[LOC_KEY] !== current) return m[LOC_KEY];
    }
    return null;
}

/** Discovered = stood in, plus any destination seen listed (and revealed) as an exit from a place stood in. */
async function discoveredAddresses() {
    const stood = await stoodInAddresses();
    const set = new Set(stood);
    for (const a of stood) for (const e of (await fetchLocationCached(a))?.exits ?? []) if (revealsDestination(e)) set.add(e.to);
    return set;
}

/** Discovered places that are not here and not one exit away: [{address, name}]. */
async function discoveredTargets(loc) {
    const adjacent = new Set(loc.exits.map(e => e.to));
    const out = [];
    for (const a of await discoveredAddresses()) {
        if (a === loc.address || adjacent.has(a)) continue;
        const l = await fetchLocationCached(a);
        if (l) out.push({ address: a, name: l.name });
    }
    return out;
}

/**
 * Shortest path (BFS over exits, within the current region) from `from` to `target`: [{direction, to}] or null.
 * Intermediate steps only pass through `stoodIn` places (when given); the target may be any known place.
 * Hidden/obscured exits (same revealsDestination check) are never used.
 */
export async function findPath(from, target, getLoc = fetchLocationCached, stoodIn = null) {
    const region = from.split(':')[0];
    const prev = new Map([[from, null]]);
    const queue = [from];
    while (queue.length) {
        const cur = queue.shift();
        if (cur === target) break;
        const loc = await getLoc(cur);
        for (const e of loc?.exits ?? []) {
            if (prev.has(e.to) || !revealsDestination(e)) continue;
            if (e.to !== target && (e.to.split(':')[0] !== region || (stoodIn && !stoodIn.has(e.to)))) continue;
            prev.set(e.to, { from: cur, direction: e.direction });
            queue.push(e.to);
        }
    }
    if (!prev.has(target)) return null;
    const steps = [];
    for (let a = target; prev.get(a); a = prev.get(a).from) steps.unshift({ direction: prev.get(a).direction, to: a });
    return steps;
}

/** Walk a route step by step through POST /move. Returns {ok, to, move} like engineMove. */
async function engineTravel(target) {
    const from = await currentLocation();
    const steps = await findPath(from.address, target, fetchLocationCached, await stoodInAddresses());
    if (!steps?.length) return { ok: false, error: 'No known route.', valid: from.exits.map(e => e.direction) };
    let at = from, names = [from.name], via = [];
    for (const st of steps) {
        const r = await api('/move', { method: 'POST', body: JSON.stringify({ from: at.address, direction: st.direction }) });
        if (!r.ok) return { ok: false, error: 'Route blocked.', valid: from.exits.map(e => e.direction) };
        at = r.body; names.push(at.name); via.push(at.address);
    }
    return { ok: true, to: at, move: { direction: steps.length === 1 ? steps[0].direction : null, from: from.address, from_name: from.name, to: at.address, to_name: at.name, path: names, via } };
}

/** Click / /ws-go: move (exit direction, or a discovered place by name), add a short user note, then narrate. */
async function goAction(direction) {
    const c = ctx();
    if (engineBusy) return 'WorldScrawl: already moving.';
    if (!direction) { toastr.warning('Usage: /ws-go <direction or known place>'); return ''; }
    if (c.characterId === undefined && !c.groupId) { toastr.warning('Open a chat first.'); return ''; }
    engineBusy = true;
    try {
        const here = await currentLocation();
        let res;
        if (here.exits.some(e => e.direction.toLowerCase() === direction.toLowerCase())) res = await engineMove(direction);
        else {
            const t = (await discoveredTargets(here)).find(v => v.name.toLowerCase() === direction.toLowerCase());
            res = t ? await engineTravel(t.address) : await engineMove(direction);
        }
        if (!res.ok) { toastr.warning(`${res.error} Exits: ${res.valid.join(', ') || 'none'}`); return res.error; }
        const note = res.move.direction ? `*The party goes ${res.move.direction}.*` : `*The party heads to ${res.move.to_name}.*`;
        await c.executeSlashCommandsWithOptions(`/send ${note}`);
        const msg = c.chat[c.chat.length - 1];
        stamp(msg, res.to, res.move);
        msg.extra.worldscrawl_engine = true; // no intent question for this message
        await c.saveChat();
        renderAllExits();
        await c.executeSlashCommandsWithOptions('/trigger await=true');
        return '';
    } catch (e) {
        toastr.error(e.message); return e.message;
    } finally {
        engineBusy = false;
    }
}

export const STAY = 'stay', ELSEWHERE = 'elsewhere';

/** Strip reasoning blocks, keep the last non-empty line, then exact-match against the options. */
export function cleanAnswer(answer) {
    const a = String(answer ?? '').replace(/<(think|thinking|reasoning)>[\s\S]*?<\/\1>/gi, '').replace(/<(think|thinking|reasoning)>[\s\S]*$/gi, '').replace(/<\/?(think|thinking|reasoning)>/gi, '');
    const lines = a.split('\n').map(l => l.trim()).filter(Boolean);
    return (lines[lines.length - 1] ?? '').replace(/^(answer|option|choice)\s*:\s*/i, '');
}
export const parseIntentAnswer = (answer, options) => parseChoice(cleanAnswer(answer), [...options, STAY, ELSEWHERE]);
export const parseYesNo = answer => parseChoice(cleanAnswer(answer), ['yes', 'no']);

const SYS = 'You classify player intent for a text adventure game. Reply with exactly one option from the list and nothing else.';

/**
 * Ask the model one multiple-choice question about the player's message.
 * Returns {kind:'move'|'stay'|'elsewhere', loc}. An unreadable answer gets a yes/no follow-up
 * ("trying to travel?"): a clear yes is 'elsewhere', anything else is 'stay'.
 */
async function parseIntent(msg) {
    const c = ctx();
    msg.extra = msg.extra ?? {};
    msg.extra.worldscrawl_intent_checked = true;
    const loc = await currentLocation();
    const dirs = loc.exits.map(e => e.direction);
    const places = await discoveredTargets(loc);
    const prev = previousAddress(loc.address);
    const options = [...dirs, ...places.map(p => p.name), STAY, ELSEWHERE];
    const said = `The player wrote: "${String(msg.mes ?? '').slice(0, 1000)}"`;
    const prompt = `The party is at ${loc.name}. Its exits are:\n${loc.exits.map(e => `- ${exitLabel(e, n => ` (to ${n}${e.to === prev ? ', where you came from' : ''})`)}`).join('\n') || '- (none)'}\n\n`
        + `${said}\n\nAnswer with one option:\n`
        + dirs.map(d => `- ${d}: the player goes through the "${d}" exit right now\n`).join('')
        + places.map(p => `- ${p.name}: the player travels to ${p.name}, a place they know about\n`).join('')
        + `- ${STAY}: the player is not trying to travel anywhere\n`
        + `- ${ELSEWHERE}: the player wants to go to a place that is not listed above\n\n`
        + `Which option: ${options.join(', ')}? Reply with exactly one option from that list.`;
    const answer = await c.generateRaw({ prompt, systemPrompt: SYS, responseLength: 48 });
    let choice = parseIntentAnswer(answer, [...dirs, ...places.map(p => p.name)]);
    if (!choice) {
        const yn = await c.generateRaw({ prompt: `The party is at ${loc.name}.\n${said}\n\nIs the player trying to travel to a different place? Answer yes or no.`, systemPrompt: 'Reply with exactly one word: yes or no.', responseLength: 48 });
        choice = parseYesNo(yn) === 'yes' ? ELSEWHERE : STAY;
        console.log(`[WorldScrawl] intent fallback: ${JSON.stringify(String(yn).slice(0, 80))} -> ${choice}`);
    }
    console.log(`[WorldScrawl] intent: ${JSON.stringify(String(answer).slice(0, 80))} -> ${choice}`);
    if (choice === STAY) return { kind: STAY, loc };
    if (choice === ELSEWHERE) return { kind: ELSEWHERE, loc };
    const place = places.find(p => p.name === choice);
    const res = place ? await engineTravel(place.address) : await engineMove(choice);
    if (!res.ok) return { kind: ELSEWHERE, loc };
    stamp(msg, res.to, res.move);
    return { kind: 'move', loc: res.to };
}

/** Display-only game message: a system message, which SillyTavern never puts in the prompt. */
async function addNotice(text, loc) {
    const c = ctx();
    // worldscrawl_notice_loc lets the exit buttons be rebuilt after a reload.
    const msg = { name: 'WorldScrawl', is_user: false, is_system: true, send_date: Date.now(), mes: text, extra: { worldscrawl_notice: true, worldscrawl_notice_loc: loc?.address ?? null } };
    c.chat.push(msg);
    c.addOneMessage(msg);
    await c.saveChat();
}

export const unreachableText = loc => `You can't get there from here. ${exitsText(loc)}`;

export function factsText(loc, move, toolsOn) {
    const lines = [
        '[World state from the game engine. This is authoritative.]',
        `Current location: ${loc.name}${loc.region?.name ? ` (${loc.region.name})` : ''}`,
        loc.description ?? '',
        exitsText(loc).replace(/^Exits:/, 'Exits from here:'),
    ];
    if (move?.path?.length > 2) lines.push(`What just happened: The party travelled from ${move.path[0]} through ${move.path.slice(1, -1).join(', ')} to ${move.to_name}. Describe the journey briefly and arriving at ${move.to_name}.`);
    else if (move) lines.push(`What just happened: The party moved ${move.direction} from ${move.from_name} to ${move.to_name}. Describe arriving at ${move.to_name}.`);
    else lines.push(`The party has NOT moved this turn and is still at ${loc.name}. Do not narrate travel to any other place.`);
    lines.push(toolsOn
        ? 'Do not invent locations or exits that are not listed.'
        : 'You only narrate. The game engine controls movement: never move the party to a different location yourself, and do not invent locations or exits that are not listed. If a character tries to leave some other way, describe why they cannot.');
    return lines.filter(Boolean).join('\n');
}

async function applyFacts() {
    const c = ctx();
    let text = '';
    try {
        const loc = await currentLocation();
        const ui = lastUserIndex(c.chat ?? []);
        const move = ui >= 0 ? c.chat[ui].extra?.[MOVE_KEY] : null;
        text = factsText(loc, move, toolsOn());
    } catch (e) { console.warn('[WorldScrawl] facts unavailable:', e.message); }
    c.setExtensionPrompt(FACTS_KEY, text, 1 /* IN_CHAT */, 1, false, 0 /* SYSTEM */);
}

/** Generation interceptor (manifest.generate_interceptor): runs before every prompt is built. */
globalThis.worldscrawlInterceptor = async function (_chat, _size, abort, type) {
    if (type === 'quiet' || type === 'impersonate') return;
    try {
        const c = ctx();
        const chat = c.chat ?? [];
        const last = chat[chat.length - 1];
        const s = settings();
        if ((!type || type === 'normal') && last?.is_user && s.moveMode === 'typed'
            && !last.extra?.worldscrawl_engine && !last.extra?.worldscrawl_intent_checked) {
            const r = await parseIntent(last);
            await c.saveChat();
            if (r.kind === ELSEWHERE) {
                abort(true); // no model call: the model would only narrate a trip that didn't happen
                await addNotice(unreachableText(r.loc), r.loc);
                renderAllExits();
                return;
            }
            renderAllExits();
        }
        await applyFacts();
    } catch (e) { console.error('[WorldScrawl] interceptor failed', e); }
};

function registerSlashCommands() {
    const { SlashCommandParser, SlashCommand, SlashCommandArgument, ARGUMENT_TYPE } = ctx();
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'ws-go',
        callback: (_args, dir) => goAction(String(dir ?? '').trim()),
        unnamedArgumentList: [SlashCommandArgument.fromProps({ description: 'exit direction, e.g. north', typeList: [ARGUMENT_TYPE.STRING], isRequired: true })],
        helpString: 'WorldScrawl: move the party through an exit, then the model narrates the arrival.',
    }));
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'ws-exits',
        callback: async () => { try { const t = exitsText(await currentLocation()); toastr.info(t); return t; } catch (e) { toastr.error(e.message); return ''; } },
        helpString: 'WorldScrawl: show the exits from the current location.',
    }));
}

// ---- Exits footer: display-only (DOM), never written into message.mes, so the model never sees it.
const exitsCache = new Map(); // address -> Promise<location|null>

function fetchLocationCached(address) {
    const key = address ?? '(start)';
    if (!exitsCache.has(key)) {
        const p = (async () => {
            try {
                const r = await api(address ? `/location/${encodeURIComponent(address)}` : '/start');
                return r.ok ? r.body : null;
            } catch { return null; }
        })();
        p.then(v => { if (!v) exitsCache.delete(key); }); // don't cache failures (server down)
        exitsCache.set(key, p);
    }
    return exitsCache.get(key);
}

/** Location in effect at message `id`: latest stamped at or before it, else null (= start). */
function locationAt(id) {
    const chat = ctx().chat ?? [];
    for (let i = Math.min(id, chat.length - 1); i >= 0; i--) {
        const loc = chat[i]?.extra?.[LOC_KEY];
        if (loc) return loc;
    }
    return null;
}

export function exitsText(loc) {
    const exits = loc?.exits ?? [];
    return 'Exits: ' + (exits.length ? exits.map(e => exitLabel(e)).join(', ') : 'none');
}

async function renderExits(id) {
    id = Number(id);
    const el = document.querySelector(`#chat .mes[mesid="${id}"]`);
    if (!el) return;
    el.querySelector('.worldscrawl_exits')?.remove();
    const msg = ctx().chat?.[id];
    if (!settings().showExits || !msg || msg.is_user || msg.is_system) return;
    const loc = await fetchLocationCached(locationAt(id));
    const fresh = document.querySelector(`#chat .mes[mesid="${id}"]`);
    if (!loc || !fresh || !settings().showExits) return;
    fresh.querySelector('.worldscrawl_exits')?.remove();
    const div = document.createElement('div');
    div.className = 'worldscrawl_exits';
    div.style.cssText = 'opacity:0.75;font-size:0.9em;margin-top:4px;font-style:italic;';
    const ch = ctx().chat ?? [];
    let lastReal = ch.length - 1;
    while (lastReal >= 0 && ch[lastReal]?.extra?.worldscrawl_notice) lastReal--;
    const isLast = id === lastReal;
    if (!isLast || !loc.exits?.length) div.textContent = exitsText(loc);
    else appendExitButtons(div, loc);
    (fresh.querySelector('.mes_block') ?? fresh).appendChild(div);
}

/** "Exits: " followed by one clickable entry per exit (shared by the footer and the can't-get-there message). */
function appendExitButtons(el, loc) {
    el.append('Exits: ');
    loc.exits.forEach((e, i) => {
        if (i) el.append(', ');
        const b = document.createElement('span');
        b.className = 'worldscrawl_exit';
        b.dataset.direction = e.direction;
        b.title = `Go ${e.direction}`;
        b.style.cssText = 'cursor:pointer;text-decoration:underline;font-style:normal;';
        b.textContent = exitLabel(e);
        b.addEventListener('click', () => goAction(e.direction));
        el.appendChild(b);
    });
}

/** The latest can't-get-there message gets clickable exits (rebuilt from stored data, so it survives reloads). */
async function renderNotices() {
    const ch = ctx().chat ?? [];
    const last = ch.length - 1;
    for (const el of document.querySelectorAll('#chat .mes[mesid]')) {
        const id = Number(el.getAttribute('mesid'));
        const msg = ch[id];
        if (!msg?.extra?.worldscrawl_notice) continue;
        const text = el.querySelector('.mes_text');
        if (!text) continue;
        const addr = msg.extra.worldscrawl_notice_loc;
        const loc = id === last && addr ? await fetchLocationCached(addr) : null;
        if (!loc?.exits?.length || id !== (ctx().chat?.length ?? 0) - 1) {
            if (text.querySelector('.worldscrawl_exit')) text.textContent = msg.mes;
            continue;
        }
        text.textContent = '';
        text.append("You can't get there from here. ");
        appendExitButtons(text, loc);
    }
}

function renderAllExits() {
    renderNotices();
    document.querySelectorAll('#chat .worldscrawl_exits').forEach(e => e.remove());
    if (!settings().showExits) return;
    document.querySelectorAll('#chat .mes[mesid]').forEach(el => renderExits(el.getAttribute('mesid')));
}

async function testConnection() {
    const status = document.getElementById('worldscrawl_status');
    status.textContent = 'Testing...';
    try {
        const r = await api('/health');
        const tools = ctx().isToolCallingSupported() ? 'function calling is ON' : 'function calling is OFF or not supported by the current API/model';
        status.textContent = r.ok ? `Connected: ${r.body.locations} locations, start ${r.body.start}. Current: ${getStoredLocation() ?? '(start)'}. ${tools}.` : `Server error ${r.status}`;
    } catch (e) {
        status.textContent = e.message;
    }
}

function addSettingsPanel() {
    const html = `
<div class="worldscrawl_settings">
  <div class="inline-drawer">
    <div class="inline-drawer-toggle inline-drawer-header"><b>WorldScrawl</b><div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div></div>
    <div class="inline-drawer-content">
      <label for="worldscrawl_url">Server URL</label>
      <input id="worldscrawl_url" class="text_pole" type="text">
      <div class="flex-container"><div id="worldscrawl_test" class="menu_button">Test connection</div></div>
      <small id="worldscrawl_status"></small>
      <label class="checkbox_label"><input id="worldscrawl_show_exits" type="checkbox"> Show exits footer</label>
      <div>Movement</div>
      <label class="checkbox_label"><input type="radio" name="worldscrawl_mode" value="commands"> Clicks and commands only</label>
      <label class="checkbox_label"><input type="radio" name="worldscrawl_mode" value="typed"> Clicks, commands and typed moves</label>
      <label class="checkbox_label"><input type="radio" name="worldscrawl_mode" value="tools"> Model moves with map tools (not recommended)</label>
      <label for="worldscrawl_nudge">Tool instructions (sent to the model each turn; leave empty to send nothing)</label>
      <textarea id="worldscrawl_nudge" class="text_pole" rows="4"></textarea>
      <div class="flex-container"><div id="worldscrawl_nudge_reset" class="menu_button">Restore default</div></div>
    </div>
  </div>
</div>`;
    document.getElementById('extensions_settings2')?.insertAdjacentHTML('beforeend', html);
    const input = document.getElementById('worldscrawl_url');
    input.value = settings().serverUrl;
    input.addEventListener('input', () => { settings().serverUrl = input.value.trim(); exitsCache.clear(); ctx().saveSettingsDebounced(); });
    const showExits = document.getElementById('worldscrawl_show_exits');
    showExits.checked = !!settings().showExits;
    showExits.addEventListener('change', () => { settings().showExits = showExits.checked; ctx().saveSettingsDebounced(); renderAllExits(); });
    document.querySelectorAll('input[name="worldscrawl_mode"]').forEach(r => {
        r.checked = r.value === settings().moveMode;
        r.addEventListener('change', () => { if (!r.checked) return; settings().moveMode = r.value; applyTools(); applyNudge(); applyFacts(); ctx().saveSettingsDebounced(); });
    });
    document.getElementById('worldscrawl_test').addEventListener('click', testConnection);
    const nudge = document.getElementById('worldscrawl_nudge');
    nudge.value = settings().nudge;
    nudge.addEventListener('input', () => { settings().nudge = nudge.value; applyNudge(); ctx().saveSettingsDebounced(); });
    document.getElementById('worldscrawl_nudge_reset').addEventListener('click', () => { nudge.value = settings().nudge = DEFAULT_NUDGE; applyNudge(); ctx().saveSettingsDebounced(); });
}

(function init() {
    settings();
    applyTools();
    registerSlashCommands();
    const { eventSource, eventTypes } = ctx();
    // ST pushes the tool-call record message into the chat right before this event and saves it right after.
    eventSource.on(eventTypes.TOOL_CALLS_PERFORMED, stampLocation);
    eventSource.on(eventTypes.CHAT_CHANGED, () => { pendingLocation = null; applyFacts(); setTimeout(renderAllExits, 0); });
    eventSource.on(eventTypes.CHARACTER_MESSAGE_RENDERED, () => setTimeout(renderAllExits, 0));
    eventSource.on(eventTypes.USER_MESSAGE_RENDERED, () => setTimeout(renderAllExits, 0));
    for (const ev of ['MESSAGE_SWIPED', 'MESSAGE_UPDATED', 'MESSAGE_EDITED', 'MESSAGE_DELETED', 'MORE_MESSAGES_LOADED']) {
        if (eventTypes[ev]) eventSource.on(eventTypes[ev], () => setTimeout(renderAllExits, 0));
    }
    addSettingsPanel();
    applyNudge();
    console.log('[WorldScrawl] loaded');
})();
