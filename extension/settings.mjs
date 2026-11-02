// Moved out of index.js unchanged (see docs/CODEMAP.md).
import { discoveryChanged } from './carriers.mjs';
import { defaultWorldId } from './clock.mjs';
import { applyNudge, applyTools } from './expiry.mjs';
import { exitsCache, renderAllExits } from './footer.mjs';
import { DEFAULTS, DEFAULT_NUDGE, applyChatState, ctx, isOn, refreshSaveName, saveWorld, setEnabled, settings } from './index.js';
import { fillWorlds, openMapWindow, openWorldFolder, testConnection } from './mapwindow.mjs';
import { applyFacts } from './scene.mjs';

function addSettingsPanel() {
    const html = `
<div class="worldscrawl_settings">
  <div class="inline-drawer">
    <div class="inline-drawer-toggle inline-drawer-header"><b>WorldScrawl</b><div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div></div>
    <div class="inline-drawer-content">
      <label class="checkbox_label"><input id="worldscrawl_enabled" type="checkbox"> <b>Enabled in this chat</b></label>
      <label class="checkbox_label"><input id="worldscrawl_enable_new" type="checkbox"> Enable in new chats</label>
      <div class="flex-container"><div id="worldscrawl_open_map" class="menu_button" title="Opens the WorldScrawl window in a new tab; it follows this chat live" style="white-space:nowrap;width:auto;padding:4px 12px;">Open WorldScrawl GUI</div></div>
      <label for="worldscrawl_url">Map server URL (leave empty to use the WorldScrawl plugin built into SillyTavern)</label>
      <input id="worldscrawl_url" class="text_pole" type="text" placeholder="(SillyTavern plugin)">
      <div class="flex-container"><div id="worldscrawl_test" class="menu_button" style="white-space:nowrap;width:auto;padding:4px 12px;">Test connection</div></div>
      <small id="worldscrawl_status"></small>
      <label for="worldscrawl_who">Who moves (used in move messages and notes to the model; macros like {{user}} work)</label>
      <input id="worldscrawl_who" class="text_pole" type="text" placeholder="{{user}}">
      <label for="worldscrawl_world">World for new chats</label>
      <div class="flex-container"><select id="worldscrawl_world" class="text_pole flex1"><option value="">(server default)</option></select>
        <div id="worldscrawl_open_world" class="menu_button" title="Open this world's folder">Open</div></div>
      <div class="flex-container"><div id="worldscrawl_open_folder" class="menu_button" style="white-space:nowrap;width:auto;padding:4px 12px;">Open worlds folder</div></div>
      <label for="worldscrawl_save_name">Save this chat's world as</label>
      <input id="worldscrawl_save_name" class="text_pole" type="text" placeholder="">
      <label class="checkbox_label"><input id="worldscrawl_save_knowledge" type="checkbox"> Include this chat's discoveries</label>
      <small>New chats on this world start where you are and already know the places and doors you've found. If it's off, new chats start fresh.</small>
      <div class="flex-container"><div id="worldscrawl_save" class="menu_button">Save world</div></div>
      <label class="checkbox_label"><input id="worldscrawl_save_switch" type="checkbox" checked> Switch this chat to the saved world</label>
      <label class="checkbox_label"><input id="worldscrawl_show_exits" type="checkbox"> Show exits footer</label>
      <div>Map changes</div>
      <label class="checkbox_label"><input id="worldscrawl_auto_keep" type="checkbox"> Approve map changes without asking (skip the Approve / Discard card)</label>
      <label class="checkbox_label" title="Off: a room is only discovered when a door that isn't on the map is actually opened or entered. On: rooms the narration mentions (a hallway lined with guest rooms) may be added too."><input id="worldscrawl_proactive_discovery" type="checkbox"> Proactive room discovery (add rooms the narration mentions)</label>
      <label class="checkbox_label"><input id="worldscrawl_flag_tags" type="checkbox"> Let the narrator flag map changes (adds one short line to the prompt)</label>
      <label class="checkbox_label"><input id="worldscrawl_narrate_expiries" type="checkbox"> Narrate expiries (when a temporary place runs out with the party inside, pick where they end up, then the narrator tells it)</label>
      <label class="checkbox_label"><input id="worldscrawl_auto_keep_waits" type="checkbox"> Approve the narrator&apos;s waits without asking (skip the Approve / Adjust / Discard card)</label>
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
    const en = document.getElementById('worldscrawl_enabled');
    en.checked = isOn();
    en.addEventListener('change', () => setEnabled(en.checked));
    const enNew = document.getElementById('worldscrawl_enable_new');
    enNew.checked = !!settings().enableNewChats;
    enNew.addEventListener('change', () => { settings().enableNewChats = enNew.checked; ctx().saveSettingsDebounced(); applyChatState(); });
    const input = document.getElementById('worldscrawl_url');
    input.value = settings().serverUrl;
    input.addEventListener('input', () => { settings().serverUrl = input.value.trim(); exitsCache.clear(); ctx().saveSettingsDebounced(); });
    const who = document.getElementById('worldscrawl_who');
    who.value = settings().whoMoves ?? DEFAULTS.whoMoves;
    who.addEventListener('input', () => { settings().whoMoves = who.value; applyFacts(); ctx().saveSettingsDebounced(); });
    const showExits = document.getElementById('worldscrawl_show_exits');
    showExits.checked = !!settings().showExits;
    showExits.addEventListener('change', () => { settings().showExits = showExits.checked; ctx().saveSettingsDebounced(); renderAllExits(); });
    const autoKeep = document.getElementById('worldscrawl_auto_keep');
    autoKeep.checked = !!settings().autoKeep;
    autoKeep.addEventListener('change', () => { settings().autoKeep = autoKeep.checked; ctx().saveSettingsDebounced(); });
    const nex = document.getElementById('worldscrawl_narrate_expiries');
    nex.checked = settings().narrateExpiries !== false;
    nex.addEventListener('change', () => { settings().narrateExpiries = nex.checked; ctx().saveSettingsDebounced(); });
    const akw = document.getElementById('worldscrawl_auto_keep_waits');
    akw.checked = !!settings().autoKeepWaits;
    akw.addEventListener('change', () => { settings().autoKeepWaits = akw.checked; ctx().saveSettingsDebounced(); });
    const proDisc = document.getElementById('worldscrawl_proactive_discovery');
    proDisc.checked = !!settings().proactiveDiscovery;
    proDisc.addEventListener('change', () => { settings().proactiveDiscovery = proDisc.checked; ctx().saveSettingsDebounced(); discoveryChanged(); });
    const flagTags = document.getElementById('worldscrawl_flag_tags');
    flagTags.checked = !!settings().flagTags;
    flagTags.addEventListener('change', () => { settings().flagTags = flagTags.checked; applyNudge(); ctx().saveSettingsDebounced(); });
    document.querySelectorAll('input[name="worldscrawl_mode"]').forEach(r => {
        r.checked = r.value === settings().moveMode;
        r.addEventListener('change', () => { if (!r.checked) return; settings().moveMode = r.value; applyTools(); applyNudge(); applyFacts(); ctx().saveSettingsDebounced(); });
    });
    document.getElementById('worldscrawl_open_map').addEventListener('click', () => openMapWindow());
    document.getElementById('worldscrawl_test').addEventListener('click', () => { testConnection(); fillWorlds(); });
    const sel = document.getElementById('worldscrawl_world');
    sel.addEventListener('change', () => { settings().world = sel.value; ctx().saveSettingsDebounced(); });
    document.getElementById('worldscrawl_open_folder').addEventListener('click', () => openWorldFolder(''));
    document.getElementById('worldscrawl_open_world').addEventListener('click', () => openWorldFolder(sel.value || defaultWorldId || ''));
    document.querySelector('.worldscrawl_settings .inline-drawer-toggle')?.addEventListener('click', () => { refreshSaveName(); fillWorlds(); });
    document.getElementById('worldscrawl_save').addEventListener('click', () => saveWorld(document.getElementById('worldscrawl_save_name').value.trim() || document.getElementById('worldscrawl_save_name').placeholder, document.getElementById('worldscrawl_save_switch').checked, document.getElementById('worldscrawl_save_knowledge').checked, { confirm: true }).then(fillWorlds));
    fillWorlds();
    const nudge = document.getElementById('worldscrawl_nudge');
    nudge.value = settings().nudge;
    nudge.addEventListener('input', () => { settings().nudge = nudge.value; applyNudge(); ctx().saveSettingsDebounced(); });
    document.getElementById('worldscrawl_nudge_reset').addEventListener('click', () => { nudge.value = settings().nudge = DEFAULT_NUDGE; applyNudge(); ctx().saveSettingsDebounced(); });
}

export { addSettingsPanel };
