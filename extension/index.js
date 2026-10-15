// WorldScrawl: engine-driven movement on the WorldScrawl map server. The engine (this extension) owns
// the party's location; the model only interprets what the player meant (one multiple-choice question)
// and narrates. Optional, off by default: the old ws_look/ws_move tools.
// The party's location is stored on chat messages (message.extra.worldscrawl_location) so that
// deleting or swiping messages rolls the location back with them.
const MODULE = 'worldscrawl';
const LOC_KEY = 'worldscrawl_location';
const DEFAULT_NUDGE = 'The world map is tracked by tools. Before describing where the characters are or where they can go, call ws_look. Whenever the characters travel through an exit, call ws_move with that exit\'s direction, then describe the new location from the tool result. Do not invent locations or exits that the tools did not return.';
const DEFAULTS = { serverUrl: 'http://127.0.0.1:5100', nudge: DEFAULT_NUDGE, showExits: true, parseIntent: true, useTools: false };
const MOVE_KEY = 'worldscrawl_move'; // {direction, from, from_name, to, to_name} on the message that moved
const FACTS_KEY = 'worldscrawl_facts';
const TOOL_NAMES = ['ws_look', 'ws_move'];
const NUDGE_KEY = 'worldscrawl_nudge';

const ctx = () => SillyTavern.getContext();
let pendingLocation = null;

function settings() {
    const all = ctx().extensionSettings;
    all[MODULE] = Object.assign({}, DEFAULTS, all[MODULE] ?? {});
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
        exits: loc.exits.map(e => ({ direction: e.direction, leads_to: e.to_name, ...(e.description ? { description: e.description } : {}) })),
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
    if (!settings().useTools) { TOOL_NAMES.forEach(n => { try { c.unregisterFunctionTool(n); } catch {} }); return; }
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
    const text = settings().useTools ? String(settings().nudge ?? '').trim() : '';
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

/** Click / /ws-go: move, add a short user note saying so, then let the model narrate. */
async function goAction(direction) {
    const c = ctx();
    if (engineBusy) return 'WorldScrawl: already moving.';
    if (!direction) { toastr.warning('Usage: /ws-go <direction>'); return ''; }
    if (c.characterId === undefined && !c.groupId) { toastr.warning('Open a chat first.'); return ''; }
    engineBusy = true;
    try {
        const res = await engineMove(direction);
        if (!res.ok) { toastr.warning(`${res.error} Exits: ${res.valid.join(', ') || 'none'}`); return res.error; }
        await c.executeSlashCommandsWithOptions(`/send *The party goes ${res.move.direction}.*`);
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

/** Ask the model one multiple-choice question: which exit (if any) does the player's message mean? */
async function parseIntent(msg) {
    const c = ctx();
    msg.extra = msg.extra ?? {};
    msg.extra.worldscrawl_intent_checked = true;
    const loc = await currentLocation();
    const dirs = loc.exits.map(e => e.direction);
    if (!dirs.length) return;
    const prompt = `The party is at ${loc.name}. Its exits are:\n${loc.exits.map(e => `- ${e.direction} (to ${e.to_name})`).join('\n')}\n\n`
        + `The player wrote: "${String(msg.mes ?? '').slice(0, 1000)}"\n\n`
        + `Is the player taking the party through one of these exits right now? Which of these exits does the player mean: ${[...dirs, 'none'].join(', ')}? Answer with exactly one word from that list.`;
    const answer = await c.generateRaw({ prompt, systemPrompt: 'You classify player intent for a text adventure game. Reply with exactly one option from the list and nothing else.', responseLength: 16 });
    const choice = parseChoice(answer, dirs);
    console.log(`[WorldScrawl] intent: ${JSON.stringify(String(answer).slice(0, 60))} -> ${choice ?? 'none'}`);
    if (!choice) return;
    const res = await engineMove(choice);
    if (res.ok) stamp(msg, res.to, res.move);
}

export function factsText(loc, move, toolsOn) {
    const lines = [
        '[World state from the game engine. This is authoritative.]',
        `Current location: ${loc.name}${loc.region?.name ? ` (${loc.region.name})` : ''}`,
        loc.description ?? '',
        exitsText(loc).replace(/^Exits:/, 'Exits from here:'),
    ];
    if (move) lines.push(`What just happened: The party moved ${move.direction} from ${move.from_name} to ${move.to_name}. Describe arriving at ${move.to_name}.`);
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
        text = factsText(loc, move, settings().useTools);
    } catch (e) { console.warn('[WorldScrawl] facts unavailable:', e.message); }
    c.setExtensionPrompt(FACTS_KEY, text, 1 /* IN_CHAT */, 1, false, 0 /* SYSTEM */);
}

/** Generation interceptor (manifest.generate_interceptor): runs before every prompt is built. */
globalThis.worldscrawlInterceptor = async function (_chat, _size, _abort, type) {
    if (type === 'quiet' || type === 'impersonate') return;
    try {
        const c = ctx();
        const chat = c.chat ?? [];
        const last = chat[chat.length - 1];
        const s = settings();
        if ((!type || type === 'normal') && last?.is_user && s.parseIntent && !s.useTools
            && !last.extra?.worldscrawl_engine && !last.extra?.worldscrawl_intent_checked) {
            await parseIntent(last);
            await c.saveChat();
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
    return 'Exits: ' + (exits.length ? exits.map(e => `${e.direction} (${e.to_name})`).join(', ') : 'none');
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
    const isLast = id === (ctx().chat?.length ?? 0) - 1;
    if (!isLast || !loc.exits?.length) div.textContent = exitsText(loc);
    else {
        div.append('Exits: ');
        loc.exits.forEach((e, i) => {
            if (i) div.append(', ');
            const b = document.createElement('span');
            b.className = 'worldscrawl_exit';
            b.dataset.direction = e.direction;
            b.title = `Go ${e.direction}`;
            b.style.cssText = 'cursor:pointer;text-decoration:underline;font-style:normal;';
            b.textContent = `${e.direction} (${e.to_name})`;
            b.addEventListener('click', () => goAction(e.direction));
            div.appendChild(b);
        });
    }
    (fresh.querySelector('.mes_block') ?? fresh).appendChild(div);
}

function renderAllExits() {
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
      <label class="checkbox_label"><input id="worldscrawl_parse_intent" type="checkbox"> Understand typed movement ("let's head to the docks")</label>
      <label class="checkbox_label"><input id="worldscrawl_use_tools" type="checkbox"> Let the model use map tools (ws_look / ws_move) instead (not recommended)</label>
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
    for (const [elId, key] of [['worldscrawl_parse_intent', 'parseIntent'], ['worldscrawl_use_tools', 'useTools']]) {
        const cb = document.getElementById(elId);
        cb.checked = !!settings()[key];
        cb.addEventListener('change', () => { settings()[key] = cb.checked; applyTools(); applyNudge(); ctx().saveSettingsDebounced(); });
    }
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
