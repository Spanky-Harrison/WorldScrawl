// WorldScrawl: gives the model two tools (ws_look, ws_move) backed by the WorldScrawl map server.
// The party's location is stored on chat messages (message.extra.worldscrawl_location) so that
// deleting or swiping messages rolls the location back with them.
const MODULE = 'worldscrawl';
const LOC_KEY = 'worldscrawl_location';
const DEFAULT_NUDGE = 'The world map is tracked by tools. Before describing where the characters are or where they can go, call ws_look. Whenever the characters travel through an exit, call ws_move with that exit\'s direction, then describe the new location from the tool result. Do not invent locations or exits that the tools did not return.';
const DEFAULTS = { serverUrl: 'http://127.0.0.1:5100', nudge: DEFAULT_NUDGE };
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
    const text = String(settings().nudge ?? '').trim();
    ctx().setExtensionPrompt(NUDGE_KEY, text, 1 /* IN_CHAT */, 1, false, 0 /* SYSTEM */);
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
      <label for="worldscrawl_nudge">Tool instructions (sent to the model each turn; leave empty to send nothing)</label>
      <textarea id="worldscrawl_nudge" class="text_pole" rows="4"></textarea>
      <div class="flex-container"><div id="worldscrawl_nudge_reset" class="menu_button">Restore default</div></div>
    </div>
  </div>
</div>`;
    document.getElementById('extensions_settings2')?.insertAdjacentHTML('beforeend', html);
    const input = document.getElementById('worldscrawl_url');
    input.value = settings().serverUrl;
    input.addEventListener('input', () => { settings().serverUrl = input.value.trim(); ctx().saveSettingsDebounced(); });
    document.getElementById('worldscrawl_test').addEventListener('click', testConnection);
    const nudge = document.getElementById('worldscrawl_nudge');
    nudge.value = settings().nudge;
    nudge.addEventListener('input', () => { settings().nudge = nudge.value; applyNudge(); ctx().saveSettingsDebounced(); });
    document.getElementById('worldscrawl_nudge_reset').addEventListener('click', () => { nudge.value = settings().nudge = DEFAULT_NUDGE; applyNudge(); ctx().saveSettingsDebounced(); });
}

(function init() {
    settings();
    registerTools();
    const { eventSource, eventTypes } = ctx();
    // ST pushes the tool-call record message into the chat right before this event and saves it right after.
    eventSource.on(eventTypes.TOOL_CALLS_PERFORMED, stampLocation);
    eventSource.on(eventTypes.CHAT_CHANGED, () => { pendingLocation = null; });
    addSettingsPanel();
    applyNudge();
    console.log('[WorldScrawl] loaded');
})();
