# WorldScrawl

A persistent, static world map for SillyTavern roleplay. A SillyTavern server plugin holds the map as JSON files, and a SillyTavern extension gives the model two tools:

- `ws_look`: the current location's name, description and exits.
- `ws_move(direction)`: go through an exit; returns the new location, or an error listing the valid directions.

This is version 0.1: static map only. Nothing is generated or created at runtime.

## Layout

```
plugin/             the SillyTavern server plugin (the map server, stateless; no npm packages needed)
plugin/world.mjs    loads + validates the world files
plugin/server.mjs   the routes, served at /api/plugins/worldscrawl/
plugin/ui/          the WorldScrawl window (map), served at /api/plugins/worldscrawl/ui/ (plain HTML/JS/CSS, no build step)
worlds/riverton/world.json    { "start_region": "riverton" }
worlds/riverton/regions/      one JSON file per region
extension/          the SillyTavern extension (manifest.json, index.js)
tests/node/         unit tests (node --test); tests/e2e/ is a headless SillyTavern test
```

## World files

`worlds/<id>/world.json`:

```json
{ "start_region": "riverton" }
```

`worlds/<id>/regions/<region_id>.json` (the region id is the file name). Every location lives in a subregion (a building, a street, a single-room stub...):

```json
{
  "name": "Riverton",
  "notes": "Flavor that applies to the whole region (optional).",
  "start": "drowned_rat/common_room",
  "entrance": "streets",
  "subregions": {
    "drowned_rat": {
      "name": "The Drowned Rat",
      "entrance": "common_room",
      "notes": "Flavor for this building/area (optional).",
      "inherit_notes": true,
      "locations": {
        "common_room": {
          "name": "The Drowned Rat",
          "description": "...",
          "exits": [
            { "direction": "out", "to": "streets/square", "description": "optional" },
            { "direction": "up", "to": "upstairs" },
            { "direction": "east", "to": "hollowmere:gate/road", "hidden": false }
          ]
        },
        "upstairs": { "name": "Upstairs Rooms", "description": "...", "inherit_subregion_notes": false, "exits": [] }
      }
    }
  }
}
```

- `entrance` (optional): the room you arrive in when travelling to a building/area by name (subregion: a room id, default its first room) or to a region by name (region: a subregion id, meaning that subregion's own entrance, e.g. `"streets"`, or a room as `sub/loc`; default the region's start). Riverton uses `"streets"`. Checked when the server starts.
- Full address: `region:subregion/location` (`riverton:drowned_rat/common_room`).
- Exit `to`: `loc` = same subregion, `sub/loc` = same region, `region:sub/loc` = another region. Every target must exist.
- Optional exit flags `obscured` / `hidden` (true/false). `obscured` = you can see the door but not what's behind it: it is listed by its label only ("trapdoor", "grate") until the party has walked through that door, from either side. `hidden` is reserved for true secret doors (not listed at all until found, which needs per-chat state); **for now `hidden` behaves exactly like `obscured`**.
- Typed moves: when the model picks an exit the player didn't refer to (its word or a word of its description, e.g. "down the stair" for the grate), an unrevealed hidden/obscured exit is rejected (normal notices: "You're not aware of such a place." for unknown places), and a normal exit loses to a single known place the player named that it doesn't lead to (that place is travelled to instead).
- **Exit type** (optional `"type"`): `"portal"` (default: a doorway, arch or stair; sight and sound `partial`) or `"open"` (a street, road or open ground; sight and sound `clear`). The presets live in `plugin/exit_types.json` (add your own type there: `{"name": {"sight": ..., "sound": ...}}`); any field set on the exit overrides its type.
- **`"sight"` / `"sound"`**: `"clear"`, `"partial"` or `"none"`. How well you see or hear the next room through the exit while it isn't shut. `clear` sight gives a fuller glimpse ("...carries well beyond it"); `none` gives no glimpse and nothing to look at; sound is what listening at the exit reports.
- **`"barrier"`** (optional object): something that closes the exit — a door, gate, curtain, trapdoor, grate. `{}` is an ordinary closed door. Fields (all optional):
  - `"closed_sight"` (default `"none"`) / `"closed_sound"` (default `"partial"`): sight and sound while it is closed. A gate is `{"closed_sight": "clear", "closed_sound": "clear"}`, a curtain `{"closed_sound": "clear"}`.
  - `"openable"` (default `true`): `false` = it can't be opened or passed at all (rubble, a bricked-up arch); the map draws it as blocked.
  - `"locked"` (default `false`): can't be opened or passed until a later feature unlocks it; the map marks it locked.
  - `"starts_open"` (default `false`): open until someone closes it (a shop door propped open). Can't be combined with `openable: false`.
  - `"stays_open"`: same meaning as below, per barrier.
  - There is one barrier per exit pair: **define it on one side only** (the "primary" side); the return exit inherits the same door (its state, lock and fields) automatically. The return exit still keeps its own `type`, `sight`, `sound`, `traversal`, `hidden`, `description` and `travel_time`. If both sides set one and they differ, the loader warns and the first side read wins; if both set the same barrier, the loader notes that only one side needs it. (A bolt or bar that only works from one side is not supported yet.) Opening/closing is stamped on the chat message like any door; it is not written into the world file.
- **`"traversal"`** (optional string): what passing through this side is like ("a long, stooping crawl"). It is given to the narrator only on the move that uses this exit. A tight passage = a longer `travel_time` plus traversal text.
- **`obscured` vs `sight: none`**: `"obscured": true` = it isn't clear where the exit goes (the destination's name and identity are hidden until the party passes through). Obscured implies sight none: the loader forces this side's `sight` and barrier `closed_sight` to `none` (and warns if the data sets them to anything else; the return exit keeps its own). `"sight": "none"` alone = the destination can't be seen from here, but it is still known where the exit goes; it does not imply obscured. Looking at or along either kind describes only the exit's own `description` (what is right at the threshold: "an iron grate over a stone stair that descends into darkness", "the road runs east out of sight"); for sight none the narrator may name the destination but not describe it, for obscured it is told the destination is unknown. So give such exits a good near-side `description`.
- Long open exits that run out of sight (a road over the horizon) should set `"sight": "none", "sound": "none"` (not `obscured`, since everyone knows where the road goes).
- Also on exits: `"travel_time"`, `"one_way": true` (no return exit expected, no warning), `"hidden"`, `"obscured"`.
- Example:
  ```json
  { "type": "open", "direction": "west", "to": "market_lane", "travel_time": "3m" },
  { "direction": "in", "to": "general_store/shop", "barrier": { "starts_open": true } },
  { "direction": "down", "to": "catacombs", "barrier": { "closed_sight": "clear", "closed_sound": "clear" }, "description": "An iron grate." },
  { "direction": "east", "to": "tunnel", "travel_time": "20m", "traversal": "A cramped, stooping crawl through the dark." },
  { "direction": "north", "to": "vault", "barrier": { "locked": true } },
  { "direction": "south", "to": "old_mine", "barrier": { "openable": false }, "description": "Collapsed rubble." }
  ```
- Legacy `"view"` still works: `"closed"` = `"barrier": {}`, `"none"` = sight and sound `none`, `"open"` = the type defaults. Hidden/obscured exits with no view or barrier get a closed barrier on that side.
- (Legacy) exit `"view"`: `"open"` (default), `"closed"` (default for hidden/obscured exits) or `"none"`; anything else is an error. **open**: the room prompt gets a one-line glimpse of the room beyond ("Looking out, you can see Village Square: <first sentence>"; "Through the gate, you can see ..." for named exits) and it counts as seen. **closed**: no glimpse; listening at it gives only a faint, muffled hint. **none**: nothing.
- Doors: a closed exit can be opened and closed (both sides share the door), by the typed intents "open a door" / "close a door", by peeking through it, or by `/ws-open <dir>` / `/ws-close <dir>`. The change is stamped on the message (swipes keep it, deleting undoes it). An opened door counts as `view: open`. Doors shut themselves: optional `"stays_open": true|false` on a region, a subregion or an exit (per door, the same from both sides: an exit-level `stays_open` on either side wins, false if the two sides disagree; otherwise the door stays open only if both rooms inherit true from their subregion/region; default false); a door that doesn't stay open counts as closed again once the party is in neither of the two rooms it connects. Closing explicitly always works. These fields are optional and Save world never adds them.
- Optional location `"views": ["streets/square", ...]`: rooms visible from here with no way through (windows). They take priority over the chat's own view links (below).
- Doors are paired at load time: a flagged exit and its return exit (the exit in its destination room pointing back) share an opaque `door` id, so walking through either side reveals both. A flagged exit with no return exit is allowed (one-way door) and logs a warning at load.
- Notes sent to the model: region notes, then subregion notes, then the location description (which wins if they disagree).
  - Subregion `"inherit_notes": false` drops the region notes for all its rooms.
  - A location's `inherit_region_notes` / `inherit_subregion_notes` override that when present (true/false). Missing = follow the subregion.
- Optional `"expandable": true/false` (default true) in world.json, a region file, a subregion or a location: whether discovery rooms may be added off a room (see Discovery rooms). Like the other inherited settings, the nearest one wins: the room's own, else its subregion's, else its region's, else world.json's. Anything but true or false is an error.
- Ids are lowercase slugs (`old_mill`). No duplicate keys anywhere, no duplicate directions in one location. Otherwise the map server answers every request with an error saying what's wrong (in the SillyTavern console too); fix the file and restart SillyTavern.

## Setup on Windows (PowerShell)

The map server is a SillyTavern **server plugin**: it runs inside SillyTavern, so there's nothing else to start. These steps assume the repo is cloned to `C:\WorldScrawl-v2` and SillyTavern is at `C:\sillyTavern\SillyTavern-Launcher\SillyTavern` (change the paths if not).

```powershell
cd C:\
git clone https://github.com/Spanky-Harrison/WorldScrawl.git WorldScrawl-v2
```

SillyTavern needs Node 18 or newer (it already has it if SillyTavern runs).

### 1. Allow server plugins

Open `C:\sillyTavern\SillyTavern-Launcher\SillyTavern\config.yaml` in Notepad, find the line `enableServerPlugins: false` and change it to:

```yaml
enableServerPlugins: true
```

Save the file.

### 2. Install the plugin and the extension

Both are junctions (links), so `git pull` updates them. In PowerShell:

```powershell
New-Item -ItemType Junction -Path "C:\sillyTavern\SillyTavern-Launcher\SillyTavern\plugins\worldscrawl" -Target "C:\WorldScrawl-v2\plugin"
New-Item -ItemType Junction -Path "C:\sillyTavern\SillyTavern-Launcher\SillyTavern\data\default-user\extensions\WorldScrawl" -Target "C:\WorldScrawl-v2\extension"
```

(The same from a `cmd` prompt: `mklink /J "C:\sillyTavern\SillyTavern-Launcher\SillyTavern\plugins\worldscrawl" "C:\WorldScrawl-v2\plugin"`.) If you already linked the extension before, skip the second line. The plugin folder must be named `worldscrawl`.

### 3. Restart SillyTavern

Close the SillyTavern window and start it again. Its console should show `[WorldScrawl] serving 1 world(s) from C:\WorldScrawl-v2\worlds`. Then reload the page (Ctrl+F5). Under Extensions you'll see a **WorldScrawl** panel; **Test connection** should say "Connected".

**After every `git pull` that changes the plugin, restart SillyTavern** (server code is only loaded at startup). Extension-only changes just need Ctrl+F5. Map files you edit by hand are picked up without a restart when the worlds list is refreshed (open the WorldScrawl panel).

### Worlds folder

By default the plugin uses the `worlds` folder next to it in the repo (`C:\WorldScrawl-v2\worlds`, also through the junction), so worlds you've already saved keep working. To use another folder, either set the `WORLDSCRAWL_WORLDS_DIR` environment variable before starting SillyTavern, or create `C:\WorldScrawl-v2\plugin\config.json`:

```json
{ "worldsDir": "D:\\My Worlds" }
```

(a relative path is relative to the plugin folder; see `plugin/config.example.json`). Restart SillyTavern after changing it. Set `WORLDSCRAWL_NO_OPEN=1` to stop **Open worlds folder** from opening Explorer.

The extension talks to the plugin at `/api/plugins/worldscrawl` on SillyTavern itself. The **Map server URL** field is only for pointing it at some other server; leave it empty. (An old `http://127.0.0.1:5100` value from the Python server is treated as empty.) The Python server is gone: you no longer need `.venv`, `pip` or `uvicorn`, and the old `.venv` folder can be deleted.

### Turn on function calling in SillyTavern

1. API Connections: use **Chat Completion** with a source that supports tools (OpenAI, Claude, OpenRouter, Google AI Studio, DeepSeek, xAI, Mistral, Custom OpenAI-compatible, and others) and a model that supports tool calls.
2. AI Response Configuration (left sliders panel): tick **Enable function calling**.
3. If you use Prompt Post-Processing, it must be None or one of the "with tools" options.

**Test connection** tells you whether function calling is currently on. Text Completion APIs (KoboldCpp, oobabooga text mode, etc.) can't use tools.

## How location is tracked

The server is stateless. The extension stores the party's location on the chat message that recorded the tool call (`message.extra.worldscrawl_location`) and always reads the latest one. Deleting or branching messages rolls the location back with them. A chat with no stored location starts at the world's start location.

## API

Design principle: **the server does the map work, the extension stays thin.** Every reply carries everything
derived from the map that the extension needs (display names, the destination's name/building/region/entrance on
each exit), so the extension never fetches a neighbouring room just to name it, and never re-implements map rules.
Hidden/obscured exits reveal nothing about where they lead (no `to`, no destination name), only an opaque `door` id. `POST /doors {doors: [ids]}` returns the destination data (`from`, `direction`, `to`, `to_name`, `to_label`, ...) of the flagged exits behind those doors; the extension asks only for doors this chat has walked through (derived from the move stamps: room left + direction, including each fast-travel step), so reveals roll back with swipes/deletes. The server stays stateless and lets `/move` and `/travel` go through any exit; it's the extension that never routes through an unrevealed door. Each player action
costs one request: a step is one `/move`, a whole fast-travel trip is one `/travel`, and rebuilding after a reload
is at most one `/rooms` batch.

- `GET /start` returns the start location.
- `GET /location/{address}` returns `{ address, region: {id, name, notes, entrance}, subregion: {id, name, notes, entrance}, name, display_name, description, effective_notes, exits: [{ direction, to, to_name, to_display_name, to_subregion: {id, name, entrance}, to_region: {id, name, entrance}, description?, hidden?, obscured? }] }` (hidden/obscured exits carry only direction, description and flags).
- `GET /rooms?addresses=a,b,c` returns `{ start, rooms: [...], unknown: [...] }`: several rooms in one request.
- `POST /move` with `{ "from": "riverton:drowned_rat/common_room", "direction": "out" }` returns the new location, or 400 with `{ "detail": { "error", "valid_directions" } }`.
- `POST /travel` with `{ "from": "...", "steps": ["out", "north"] }` walks the route step by step with the same rules as `/move` and returns `{ location, path, steps_completed, steps_requested, stopped, reason }`. `location` is the room actually reached; the walk stops early at the last valid room if a step is blocked (`reason: "blocked"`; `null` when the whole route was walked; later, encounters may stop a trip too). The extension always trusts `location`.
- `GET /health` returns counts, the start address and the map version.
- Every reply has an `X-WorldScrawl-Map-Version` header (a hash of the map files at load). When it changes, the extension forgets the rooms it remembered.
- The server log has one line per move and per trip (from, direction/steps, result).

## The WorldScrawl window (map)

A second window, served by the plugin, that shows the map of the chat you're playing.

**Open it** with **Open map window** in the WorldScrawl settings panel, with `/ws-map`, or by going to
`http://127.0.0.1:8000/api/plugins/worldscrawl/ui/` (use your own SillyTavern address and port) in another tab.
It has to be on the same address as SillyTavern, in the same browser. Keep the SillyTavern tab open: that tab
tells the window what's happening.

- **Top bar** like SillyTavern's. For now it has one window, **Map**; more (world browser, editor, character)
  come later. Open windows fill the space below the bar. They sit side by side in a wide (landscape) window and
  stack in a tall (portrait) one.
- **Colours** follow your current SillyTavern theme. They update when the chat does. If SillyTavern isn't
  connected yet, the window reads the theme from your saved settings, and falls back to a dark theme.
- **Live.** Every time the chat changes (a move, a door, a dig, a swipe or delete, a different chat), the
  extension sends the chat's world, location, the places stood in and seen, the revealed and open doors, and
  the chat's changes on a browser `BroadcastChannel('worldscrawl')`. The window asks for that when it opens.
  If no WorldScrawl chat is open, it says so.
- **Play-mode map: only what this chat has discovered.** It shows rooms you've stood in (solid), places you've
  only seen (dashed outline, no exits of their own), and the chat's dug exits. An exit whose destination you
  haven't found (a hidden or obscured door you haven't been through) is a small "?" stub with just its label.
  It never shows where the exit leads. Closed doors are dashed lines. Your room has a highlighted border, and the
  map centres on it whenever you move. Colours group rooms by building or area.
- **Layers.** The map has three levels. **World** shows one node per region, joined where regions connect.
  **Region** shows one node per area (subregion: a building, a street, ...), joined if any exit links them.
  **Area** shows that area's own rooms, plus small "→" nodes for the areas right outside it. The map opens on
  the area you're in and follows you when you move. The **breadcrumb** in the top bar (World › Riverton › The
  Drowned Rat) goes back up. **Double-click** an area node, or click it and press **Open …** in the side panel,
  to go down. The discovery rules apply at every level: only areas and regions you've found are shown, hidden
  exits don't link anything until revealed, and places you've only seen don't give away where their exits go.
- **Layout.** Organic and branching. Linked places pull together. Compass exits (north, east, up, ...) only nudge
  the direction; other exits (in, back, window, ...) don't. It is worked out from the data, so it works for any
  world, and it's the same every time for the same map. It starts from the layer's entrance, using the same
  `entrance` as travel: in an area, its entrance room (default its first room); in a region, the area holding the
  region's entrance (default its start); in the world, the start region. If that isn't discovered yet, it starts
  from the most connected place (lowest id on a tie). It branches out from there. The positions of each layer are remembered in the browser, so rooms don't jump
  around when new ones appear. A room with a `pos` (`{"x": 0, "y": 0}`, in link lengths) is pinned there.
- **Controls.** Drag to pan, use the wheel or a two-finger pinch to zoom, and click a room to see its name,
  description and exits in the side panel. **Centre** jumps back to where you are (and its area).

Optional world-file hint, ignored by the game itself: `"pos": {"x": 2, "y": -1}` on a location (numbers; anything
else is an error).

The window only reads. It never changes the chat or the world files. Room data comes through the normal
`/rooms` and `/doors` endpoints, so it follows the same rules as the extension. Plugin files changed, so
**restart SillyTavern** after updating to get the window.

## Prompts and the Prompt Editor

Every prompt WorldScrawl sends to the model lives in `plugin/prompts/default.json` (61 entries), plus a `placeholders` dictionary (a plain-English description of every placeholder; when a value comes from a fixed set of engine words, like `{{verb}}`, the description lists them) and a `groups` list (`id`, `title`, and `flow`, a plain description of how the group's prompts are used). Each has an `id`, a `title`, a `description`, the `group` it belongs to, optional `piece: true` (a small fragment) and `locked: "reason"` (the game depends on its wording), the `text` (a plain string; `\n` is a line break) and its `placeholders`. A placeholder is written `{{name}}` and is filled in by the game when the prompt is used; `generated` ones (like `{{edit_types}}`, the list of map edit types) are built by the game and can't be edited, and `optional` ones may be left out. Filling is done once: text that goes into a placeholder is never filled again. A test checks that the built-in prompts give exactly the same text as before they were moved into the file.

**Tools > Prompt Editor** (in the map window) edits them:

- **Profiles.** The picker at the top chooses the profile in use; New, Duplicate, Rename and Delete manage them. **Default** is the built-in text and is read-only: start typing on it and you're asked to make a profile first. A profile keeps only the prompts you changed (its overrides), so it picks up later improvements to every other prompt. Profiles are saved per SillyTavern user in `<user folder>/worldscrawl/prompts.json`, so they survive restarts and updates.
- **Groups.** At the top, **Writing style** (open by default) holds the prompts and lines that shape the prose itself: how Narration describes a move, a trip, a door or looking around, how Breaking through and New room behind a door name and describe a new room, how Map changes write changed descriptions, and Expand with AI. Each says which process uses it. The other prompts are grouped by the job they do: Pick one option (the shared base for pick-one questions), Player intent, Breaking through, Looking, Doors, Narration, Map changes, New room behind a door, and Expand with AI. The other groups start collapsed; click one to open it. Its header shows how many prompts it has and how many you've edited, and the top of the group explains in plain English how its prompts are used, step by step. Each prompt's description says which step it is (for example "Step 2 of 5: …"). Searching opens every group.
- **Placeholders.** Hover a placeholder to see what it means, or open "What the placeholders mean" under a prompt for a small table. `{{party}}` is who is travelling (the "Who moves" setting, e.g. your persona name, or your persona and the character); its old name `{{who}}` still works in saved profiles.
- **Pieces.** Tiny fragments that get slotted into bigger prompts (a retry note, a field label, a short added sentence) sit in a collapsed "Pieces" list at the bottom of their group.
- **Locked prompts** 🔒. Everything outside Writing style is locked, because the game reads the model's answer back (a fixed word, an option key, a JSON format) or relies on the instruction (the narrator's rules, the ws_flag instructions and hints). Locked prompts are still shown in full, with the padlock and a one-line reason, but the text box is read-only. **Debug > Unlock locked prompts** (off by default) makes them all editable if you really want to.
- **Each prompt** shows its title, what it's for, the text (drag the corner to make it taller), and its placeholders. **Submit** saves; **Undo edits** goes back to the last saved text; **Reset to default** drops your change. Changed prompts are marked "● edited". If your text drops a placeholder the game needs, you're warned and asked before it saves.
- **"Default changed since you edited this".** Each saved change remembers the default text it was based on. When an update changes that default, the prompt shows this badge; open it to see a diff of the old and new default, so you can carry the change over.
- **One tool at a time.** Clicking the map (or another window button, Editor, or another Tools item) closes the open tool. If the Prompt Editor has edits you haven't submitted, you're asked "Discard unsaved changes?" with **Save** (submit them all, then switch), **Discard** (switch) and **Stay**.
- Saving takes effect right away in SillyTavern (no reload).

Server routes (under `/api/plugins/worldscrawl`): `GET /prompts/active` (`{profile, prompts: {id: text}}`), `GET /prompts` (everything the editor needs), `POST /prompts/select {profile}`, `POST /prompts/profile {action: new|duplicate|rename|delete, name, from}`, `POST /prompts/override {profile, id, text}` (saving the default text removes the override), `POST /prompts/reset {profile, id}`.

## Menus: Tools and Debug (adding a tool)

The map window's top bar has a **Tools** menu right after "WorldScrawl" and a **Debug** menu at the far right. Both are built from lists in `plugin/ui/app.js`:

```js
export const TOOLS = [
    { id: 'prompts', label: 'Prompt Editor', open: () => openToolView('prompts', 'Prompt Editor', body => promptEditor(body, io)) },
];
export const DEBUG = [
    { id: 'show-edit-messages', label: 'Show map edit messages', toggle: true, checked: () => ..., set: on => ... },
    { id: 'reveal-map', label: 'Reveal map', open: () => ... },
];
```

An item is an action `{id, label, open()}` or a toggle `{id, label, toggle: true, checked(), set(on)}` (shown with a checkmark when on). To add a tool, add one entry to `TOOLS` whose `open()` calls `openToolView(id, title, build)` from `plugin/ui/menus.mjs`: `build(body)` fills the view, which takes over the whole window under the top bar with the same title and **Close** button as every tool. `build` may return `{onClose}`; returning `false` from it keeps the tool open (the Prompt Editor uses this to ask about unsaved edits).

Debug items:

- **Show map edit messages** (setting `showEditMessages`, off by default). Off: the hidden chat messages that carry map edits are shown as a thin collapsed bar. On: they're shown as full messages with their list of changes open.
- **Reveal map** asks first, then does the same as `/ws-reveal all` in the chat open in SillyTavern.

## On/off per chat

WorldScrawl is switched on or off **per chat**, so WorldScrawl chats and normal chats can sit side by side. The choice is saved in the chat's metadata (with the chat; swipes don't change it). Use **Enabled in this chat** at the top of the settings panel, the **Enable/Disable WorldScrawl for this chat** entry in the Extensions (wand) menu next to the chat input, (it follows the current chat when you switch chats) or `/ws-on` / `/ws-off` (these work even while it's off). A chat with no saved choice is on if it already has WorldScrawl stamps (older chats), otherwise it follows **Enable in new chats** (global, default off).

Off behaves as if the extension were uninstalled: every prompt injection is cleared (world state, after-message reminder, tool nudge), map tools are unregistered, footers and notice buttons are hidden, and every event handler does nothing (no intent questions, no server calls, no stamps, no greeting stamp, no missing-room notice, no swipe/delete fix-ups). Other `/ws-` commands answer "WorldScrawl is turned off." Nothing already stamped is changed or removed, and other settings stay editable. Messages sent while off just have no stamps (the location carries forward). Turning it on does exactly what loading the chat does: rebuilds from the stamps, re-renders footers and re-injects the world state right away. A chat that has never been on gets its world and start location stamped on the greeting (message 0) when it's turned on, the same place a new chat gets them.

## Worlds

Every folder in `worlds/` with a `world.json` is a world; its id is the folder name (letters, digits and dashes only). `worlds/riverton` (the former `world/` folder) is the default world (`WORLDSCRAWL_DEFAULT_WORLD` changes it; `WORLDSCRAWL_WORLDS_DIR` points at another worlds folder; the old `WORLDSCRAWL_WORLD_DIR` still serves one folder as world `default`). `world.json` may have an optional `"name"`. Each world has its own map version. Saved worlds other than riverton are ignored by git.

- The extension's room cache is keyed by world and address (never shared between worlds), it resolves a chat's world (stamping a new chat's world from the current "World for new chats" setting) before its first room request, and it always sends `?world=` once the default world is known.
- Every map endpoint takes `?world=<id>` (default world if omitted). Bad ids are rejected (400), unknown ids are 404.
- The server rescans the worlds folder on every `GET /worlds` (and when asked for an unknown world), so worlds added, edited or deleted by hand show up without a restart. A world that's gone answers 404 with `{"detail": {"error": "world_not_found", "world": id}}`.
- `POST /open-folder[?world=<id>]` opens the worlds folder (no id) or one world's folder in the system file browser (Explorer on Windows). It takes only a world id, never a path, and refuses anything outside `worlds/`. The settings panel has **Open worlds folder** and an **Open** button next to the world picker.
- **Missing worlds:** if a chat's world folder is gone, the chat uses the world it was saved from (the switch stamp's `from`, if that still exists), else the default world, and posts one notice in the chat with buttons to move the chat onto another world (stamped as a switch on that notice; delete it to undo). Stamps are never changed. The picker drops deleted worlds and "World for new chats" resets to the default if its world is gone.
- `GET /worlds` → `{default, worlds: [{id, name, start_region, start, map_version, has_knowledge}]}`.
- `GET /worlds/{id}/knowledge` → `{knowledge}`: the saved chat knowledge, or null.
- **Living saves:** `world.json` may have `"living": true|false` (strictly a boolean; anything else fails at load). Missing or false = pristine/protected (riverton has `"living": false`). Every saved world gets `"living": true`. Saving under the name of an existing living world saves over it; a protected world is always refused. Saving over is safe: the new version is written to a temp folder and swapped in, and exactly one backup of the previous version is kept in `worlds/.backups/<id>/` (dot-folders are never loaded or listed). When the chat is on a living save, the Save box offers that world's name, so a blank save goes over it; typing a new name branches a copy; the generated default is used only on a pristine world. Saving over the chat's own current world needs no confirmation. Saving over a *different* living world needs confirmation: the panel's Save button asks in a popup; `/ws-save-world` has no popup and refuses with "Add overwrite=true to save over it." (`/ws-save-world overwrite=true <name>` saves over it; the API's `overwrite: true` does the same and never applies to protected worlds). Saving over the world the chat is on always stamps a rebase on the save message (whatever the switch toggle says), so earlier changes aren't replayed twice.
- World names: the name is stored exactly as typed in the world's `world.json` (`"name"`) and shown everywhere (picker, toasts, the "[Engine: world saved as "..."]" message, the world-switch toast). The folder id is a readable slug made from it ("My Riverton!" → `my-riverton`). A typed name equal to an existing world's name (ignoring case and surrounding spaces) saves over it if that world is living and is refused otherwise; if only the folder slug is taken, `-2`, `-3`... is added. Leaving the name blank saves under exactly the name shown in the Save box placeholder: "<base world> - <character> - <Mon D, h:mm AM>" (refreshed when the panel opens, the chat changes and after each save; `/ws-save-world` with no name uses the same default). Generated names never get refused: a clash adds " (2)" to the name and `-2` to the folder (`riverton-desirae-oct-19-2`).
- `POST /worlds/render {base?, name?, auto?, id_hint?, id?, changes: [...], knowledge?: {location, stood, seen, doors}}` writes a full new world folder (`id` = exact folder id, refused if taken; normally omitted so the server picks the slug): the base world's files with `changes` applied, in the normal hand-written format (no derived data). It's loaded right away. It never replaces anything: an id that already exists (any world folder, including riverton; compared case-insensitively) is refused with 409. With `knowledge` it also writes `knowledge.json` next to the region files (entries that don't exist in the new world are dropped).
- `POST /move` and `POST /travel` accept `changes` (this chat's world changes), applied for that request only.
- Change types (`plugin/changes.mjs`; anything else is rejected): `{type: "add_exit", from, direction, to, description?}`, `{type: "remove_exit", from, direction}`.

**Per-chat world state** lives in message stamps (the server never stores gameplay state):
- A new chat stamps its world (`{id, version}`) on the greeting, taken from the "World for new chats" setting (default: the server's default world). Chats with no world stamp use the default world. If the server's map version differs from the chat's, a warning (and one toast) is shown, but nothing is blocked.
- `/ws-dig <dir>[/<returndir>] <known place>`, `/ws-dig <dir> new <name>[: description]` and `/ws-removeexit <direction>` post a short system message ("[Engine: a passage north to Village Square was opened (back: south).]") carrying the change. Deleting that message undoes the change.
  - Digs are two-way: the return exit is the opposite for north/south/east/west (and diagonals), up/down, in/out, otherwise `back`; `dir/returndir` overrides it. Refused if either side already has that exit name. `oneway=true` makes only the exit from here.
  - `new <name>` creates a new room in the current building/area (generated unique id), saved into the region file by Save world.
- **Narrative digging** (typed moves): "I smash out the window" can open a new exit. The intent check has a `new opening` choice (offered only when the message uses a breaking-through word or phrase: smash, break/broke, burst, bash, blast, shatter, breach, dig/dug, carve, hack/cut/punch through, kick in/down/through, knock down/through, tear down/through, make/open a hole; bare "tunnel" or "hole" don't count, and a stray "new opening" answer is handled like any other unreadable answer). Then **one** JSON question (`dig.question`), on the same connection as the intent check: the rooms up to 3 steps away over the map are listed as short keys (nearest first, max 12; name, area, first sentence of the description only, never which door leads where), plus a new place where new rooms are allowed (`"expandable"` not false). The answer is `{"existing": key}` or `{"new": {"name", "description"}}`, plus `direction` (the opening's name from this side, not already used), `return_direction` (default "back", not already used on the other side) and `then`: `stay` or `go_through`. Only a clear "stay" keeps the party where they are; anything else moves them through in the same turn. A bad answer is asked once more with the error. An existing place gets the linked exit pair (a `dig` change); a new place is made with the same `create_place` edit the editor and discovery use (a `patch` change, engine-made id).
  The change (and the move, if any: dig first, then location = destination, which makes it discovered) is stamped on the player's message, like a move: swiping/regenerating the reply keeps it; deleting the message undoes it. If no answer fits, nothing changes, a notice says "Nothing gave way", and the narration is told the attempt failed.
- **Looking** (typed moves): the `look` choice is offered when the message uses a whole word like look/peer/peek/gaze/glance/listen/watch/see. Then small pick-one questions (keys, 2 tries each): *What is the player looking at or listening to?* (`around`, the room's exits keyed by exit name, never an unrevealed hidden exit, plus `window`: out a window or opening with no exit). An open (or opened) exit shows the room beyond; a closed one asks what they do at it: `listen` = a faint hint only, `peek`/`open` = the door is opened (stamped) and the room shown, `look` = just the closed door; `none` or an unrevealed obscured exit shows nothing. A window uses the location's `views`, else an earlier view link, else asks *Which place can they most likely see?* from the nearby-room list (`POST /nearby`) and stamps a `view_link` change so the same place is seen next time (Save world writes it into `views`). The party never moves. Seen places are known for "I go to X" when a route through visited rooms exists; routes and fast travel only pass through rooms the party has stood in.

- **Save world** (`/ws-save-world [switch=false] [knowledge=true] <name> [--knowledge]`, or the settings button) renders the chat's world plus its changes into a new world. Map changes are always baked in. **Pristine** (default) writes no knowledge, so new chats start fresh at the world's start. **Include this chat's discoveries** ("with knowledge") also writes `knowledge.json` (places stood in, places seen, revealed doors, current location as the start). A new chat on that world seeds those from it on message 0 (seed + later stamps; swipes can't remove the seed).
- **Rebase:** every save posts a system message ("[Engine: world saved as \"Name\". This chat now uses it.]"). With switch on (default) that message carries a rebase stamp `{id, version, rebase: true, at, from}`. From then on the chat is built on the new world and only changes stamped after that message are replayed (earlier ones are baked in). Locations, known places and revealed doors keep working (same addresses). Deleting or swiping away that message puts the chat back on the previous world with its changes.
- Missing rooms, exits or doors in stamps (e.g. edited out of the map) are skipped with a console warning. If the current location itself is gone, the party is put at the world's start with a short system notice (delete it to undo).

## Prompt rules (for developers)

- **Pick-one questions use short text keys, never numbers.** List options as `- key: meaning` lines (`optionLines`), keys made with `keyFor` (lowercase words joined by `_`, unique; places use their name, plus the area only when two share a name) and end with "Reply with just the key.". Send them with the locked shared system prompt `pick.system` (`pickSys()`).
- **Read answers leniently, retry once.** `matchKey` ignores case, punctuation, markdown and `<think>` blocks; an exact key wins, else the longest key that appears as whole words, if only one does. If nothing matches, ask the same question once more (`askValid`/`pickKey`), then give up gracefully.
- **Structured answers are one JSON call.** When a step needs several facts (Breaking through, discovery), ask for one JSON object, check it in code, and on failure ask once more with the error in the retry piece. Place choices inside the JSON use the same keys and `matchKey`.
- **New places go through the shared create-place path** (`discoverToCreate` → `/patch/preview` → a stamped `patch` change); connecting to an existing place adds one exit pair. The server stays stateless: everything is a stamp or patch on a message.
- **Style vs format.** Wording that shapes prose (how a name or description is written) goes in a **Writing style** entry (`group: "style"`, unlocked, usually a piece slotted in with `{{style}}`); the parts the game reads back (keys, JSON fields, retry notes) stay locked in their own group. A split must render the default text byte-for-byte as before (the prompt snapshot test checks this).
- Every new prompt needs a title, a step description, its group's flow text updated, placeholders listed in the top-level `placeholders` dictionary, and a case in `tests/node/fixtures/prompt-cases.mjs`.

## Tests

```bash
node --test tests/node/
ST_SRC=/path/to/SillyTavern tests/e2e/run.sh   # headless: real ST 1.19 + fake model + Chrome (needs playwright-core)
```

## Movement (v0.2): the engine moves, the model narrates

By default the model never touches the map:

- **Click an exit** in the "Exits:" line under the latest reply, or type `/ws-go north`. The extension moves you, adds a short note ("*Knarfy goes north.*") and asks the model to narrate the arrival. The **Who moves** setting (default `{{user}}`) sets that phrase; macros like `{{user}}` are resolved by the extension before the text is used in the note, the questions to the model or the notes for the model.
- **Typed movement** ("let's head to the docks"): before each reply the extension asks the model one multiple-choice question, "Which of these exits does the player mean: south, north, none?". Only an exact answer from that list moves the party; anything else means no move. The answer can also be "stay" (not travelling) or "elsewhere" (wants a place that isn't an exit or a known place). If the answer is unreadable, a second question asks "Is the player trying to travel to a different place? yes/no"; only a clear yes counts as travel. For "elsewhere" the model isn't called at all; a game message says "You're not aware of such a place." (unknown place) or "You don't know a way to <place> from here." (known place, no allowed route), with clickable exits (shown in chat, never sent to the model). The exit back to where the party came from is marked, so "go back" works.
- **Known places**: places the party has stood in plus places seen listed as exits from them (per chat, rolls back with swipes/deletes). Typing "go to the temple" or `/ws-go Temple of the Tides` walks the shortest route through the exits, passing only through places the party has stood in and never using hidden exits, in one `/travel` request, and the model is told the rooms passed through in order and asked to narrate the journey briefly, ending at the arrival room. Unknown places can't be reached. Whether an exit reveals its destination is decided in one function (`revealsDestination`), ready for hidden exits later.
- Every turn the model gets the current location, its exits and what just happened as authoritative facts, and is told not to move the party or invent exits.
- **Exit labels** (footer, buttons, notes to the model) come from the server's `to_label`: within the same building just the room ("back (Courtyard)"); into another building at its entrance the building ("inn (The Gilded Goose)"), except for subregions with `"label_rooms": true` (streets and other groups of named public places), which always show the room ("out (Village Square)"); into another room of another building both ("gate (The Drowned Rat, Stable)"); crossing into another region adds the region name. When the destination is just the exit's own word ("stable" → Stable, "kitchen" → Kitchens) it is shown once. Non-compass moves say where they go ("*Knarfy goes to the Stable.*", "*Knarfy goes through the gate to Market Lane.*"). Hidden/obscured exits show only their label, and the move message never names where they lead ("*Knarfy goes through the trapdoor.*" / "*Knarfy takes the crawlspace exit.*").
- **Arrival notes** name the room before the building and the way in ("User arrives in the Stable of The Drowned Rat, entering through the gate from Market Lane. They are in the Stable, not the Common Room or any other part of The Drowned Rat."), and on move/travel turns a short `[Engine: this turn ends in ...]` reminder is placed right after the player's message, because small models weigh the last lines most.
- **Building by name** ("go to the Drowned Rat") goes to the nearest known room of that building, even if the model picks the building's entrance room, unless the player named that room.
- `/ws-exits` shows the current exits.
- Movement setting (radio): "Clicks and commands only", "Clicks, commands and typed moves" (default), "Model moves with map tools (not recommended)" (the old `ws_look` / `ws_move` tools).

### Place names in typed travel

- Rooms are offered to the model as "Name (Building)", e.g. "Common Room (The Gilded Goose)". Building and region names work too ("go to the Drowned Rat"): you arrive at the building's entrance, or at a room of that building you've already been in if it's nearer (e.g. the Drowned Rat's stable, through the stable gate on Market Lane). The Drowned Rat now has a common room, upstairs rooms, a courtyard, kitchens and a stable. East Road now leads on (about two hours' walk) to a second town, **Larkspur** (`regions/larkspur.json`): a hillside spa and wool town with the Larkspur Baths, Wren's Apothecary, Hollin Dyeworks, Sable's Bindery and the Larkspur Playhouse.
- If the model answers "elsewhere" or "unclear", the extension checks your words against known places itself (case-insensitive, word-level: "upstairs" matches "Upstairs Rooms"). One match: you go there. Several: "Which one do you mean?" with buttons. Already inside the named building/region: "You're already in X." None: "You're not aware of such a place."
- Locations are cached in memory (cleared on page reload or when the server URL changes), so each place is fetched from the server once.

## For card authors: "Start your adventure"

Put `[ws-start]` anywhere in a character's greeting (or alternate greetings). WorldScrawl shows a **Start your adventure** button there instead of the marker; clicking it sends "I look around" as your first message, so the model only runs when you choose to start. The greeting's stored text isn't changed, and the button disappears once the chat has more than the greeting.

`/ws-reveal all` marks every place in the world as visited, so the map shows it and `/ws-go` / clicking a place can travel there. `/ws-reveal region` and `/ws-reveal subregion` do the same for the region or subregion you're in; `/ws-reveal <id>` takes a place (`riverton:streets/market_lane`), subregion (`riverton:streets`) or region (`riverton`) id. It's stamped on a small message like other knowledge (no review card): delete that message, or type `/ws-reveal off` to turn the latest reveal off. Moves redirect revealed places like any other stamped address.

`/ws-known` lists the places this chat knows, in two groups: "Been there" and "Seen" (places spotted through exits or windows but never visited). It never names hidden-exit destinations.

**Looking at closed doors.** When you look at a closed door, the engine asks which of four things you did: listen (only faint sounds), peek (you glimpse the room beyond, but the door stays shut and the peek is recorded on the message as `worldscrawl_peek`), open (the door opens), or just look (you're told the door is closed). The narrator is told to mention every exit only when you arrive somewhere or explicitly look around. Exits whose destination is obscured are named only by their label.

## Game time

Time passes on travel **and** on waiting or sleeping (see *Waiting and sleeping* below). Each exit can have `"travel_time"`: `"2h"`, `"90m"`, `"1h30m"`, `"45s"`. Without one, a step inside one subregion (a building's rooms, along one street) takes 1 minute, into another subregion 3 minutes, into another region 10 minutes. Every move stamps its seconds on its chat message (`worldscrawl_move.seconds`; a multi-step trip stamps the sum of its steps), so swipes keep it and deleting the message undoes it. The clock is the world's `start_date` plus those seconds; saving a world writes the current clock as the saved world's `start_date` in the same write. The date, weekday and time of day go to the narrator, the footer under the latest reply, and the map window's top bar.

`world.json`:

```json
"start_date": { "year": 1247, "month": "April", "day": 12, "time": "08:00" },
"calendar": {
  "hours_per_day": 24,
  "days_of_week": ["Moonday", "Tideday", "Fireday"],
  "months": [
    { "name": "Thaw", "days": 30 },
    { "name": "Frost", "days": 28, "leap_every": 4, "leap_days": 1 },
    { "name": "Midwinter", "days": 1 }
  ]
}
```

`calendar` is optional (default: Gregorian, February gets a 29th every 4th year, weekdays match real dates 1900-2100). The week is as long as `days_of_week`; a year is all its months added up; hours, minutes and seconds are always 60/60. `leap_every`/`leap_days` (default 1) are per month. Optional `first_weekday` picks which day name year 1 starts on (index, default 0). Time of day: night, dawn, morning, afternoon, evening, scaled to `hours_per_day` (on 24 hours: dawn 5-7, morning 7-12, afternoon 12-17, evening 17-21).

### Waiting and sleeping

Time can pass without moving:

- `/ws-wait 2h`, `/ws-wait 1h30m`, `/ws-wait 2d` wait that long. There is no upper limit.
- `/ws-wait until dawn` (also `morning`, `noon`, `dusk`, `evening`, `night`, `midnight`, or a clock time like `14:30`) waits until the next one. If it has already passed today, it waits until tomorrow's. Dawn and dusk follow the place's sunrise and sunset from the weather. Custom calendars with a different `hours_per_day` work too.
- `/ws-sleep` sleeps 8 hours. `/ws-sleep 6h` and `/ws-sleep until morning` work like `/ws-wait`, and the narrator is told to narrate waking up.
- The map window's **Wait…** menu has quick picks: wait 1 hour, wait until morning, sleep 8 hours. It asks the SillyTavern tab to post the message; the map never changes anything itself.
- The narrator can pass time too, with its own `ws_wait` tool (tools mode). It gives a `duration` (`"2h"`, `"1h30m"`, `"2d"`) or an `until` (`"morning"`, `"dusk"`, `"14:00"`), plus `sleep: true` when the characters sleep (8 hours if nothing else is given). In the other modes the narrator is told to end its reply with a tag instead, such as `[ws_wait: 2h]`, `[ws_wait: until dusk]`, `[ws_wait: sleep]` or `[ws_wait: sleep until morning]`. The tag is removed from the reply. Either way the wait is stamped straight away, like a move, with no review card and no limit.
- The older route still works: the `ws_flag` tool with action `wait` or `sleep`, or a `[ws_flag: wait | 2h]` / `[ws_flag: sleep | until morning]` tag.

A wait is stamped on its chat message (`worldscrawl_wait.seconds`) exactly like a move's travel time. Deleting the message undoes it, and swipes keep it. On the next reply the narrator is told how long passed, the time before and after, a change of light (night to dawn and so on), how the weather changed, and any temporary map changes that ran out during the wait. The map's top bar shows the wait next to the clock.

## Weather

Weather is worked out from the world's seed, the place's weather region and the game time, so it is the same every time you look, survives swipes and deleted messages, and moves on with the clock. The narrator gets one line (sky, wind, temperature and feels-like, humidity, what is underfoot, season), and a short version shows in the footer and the map window's top bar. Behind it: weather comes in stretches (a storm for a few hours, clear for most of a day) chained by odds that suit each sky and season, wind shortens stretches and makes change more likely, seasons blend into each other, temperature follows the day and the sky and drifts from day to day, rain turns to sleet and snow in the cold, the ground stays wet, snowy or icy for a while afterwards, and day length follows the season. You only set a few fields.

### `world.json`

```json
"temperature_unit": "F",
"weather_seed": "riverton",
"weather_regions": { "riverside": { "climate": "temperate" } }
```

- `temperature_unit`: `"F"` (default) or `"C"`. Every temperature you write in the world (and that the narrator sees) uses it.
- `weather_seed`: optional; defaults to the world's name. Saving a world writes it, so a copy keeps the same weather.
- `weather_regions`: optional named weather areas that several regions share. Takes the same `climate`, `seasons`, `daylight_adjust` and `temp_offset` as a region; when a region joins one, the weather region's settings win.
- `climates`: optional custom climates by id (see below).

### Region (`regions/*.json`, top level)

```json
"weather_region": "riverside",
"climate": "oceanic",
"seasons": { "winter": ["December", "January", "February"], "spring": ["March", "April", "May"], "summer": ["June", "July", "August"], "autumn": ["September", "October", "November"] },
"daylight_adjust": 0.5,
"temp_offset": -3
```

- `weather_region`: share weather with other regions. Without it, the region has its own weather.
- `climate`: a preset id (table below), a Köppen code (`"Cfb"`), `"temperate"` (= `humid_continental_warm_summer`, the default) or one of the world's `climates`.
- `seasons`: optional; which months belong to which season of the climate. Every month needs exactly one season and a season's months must be in a row (wrapping round the year is fine). Presets come with Gregorian months; on a custom calendar without `seasons`, the year is split evenly.
- `daylight_adjust`: hours added to the longest day and taken from the shortest (higher latitude feel).
- `temp_offset`: degrees warmer (or colder, negative) than the weather region; adds up through region, subregion and location (a hill, a cold valley, a hot forge yard).

### Exposure (region, subregion or location)

The nearest level that sets one wins: location > subregion > region. Default `outdoor`.

```json
"exposure": "sheltered", "indoor_temp": 72, "insulation": "cozy"
```

- `outdoor`: full weather.
- `sheltered`: the narrator gets the weather outside plus the temperature inside. `indoor_temp` is what the fire/heating aims for (`null` = no heating); `insulation` how much of the gap it closes: `drafty` 30%, `normal` 60% (default), `cozy` 85%. A level that sets its own `exposure` does not inherit heat settings from above it (a cellar under a warm inn).
- `enclosed`: no weather at all, steady temperature (the climate's yearly average, or `indoor_temp`): cellars, caves, tunnels.
- `fixed`: always the same: `"fixed_weather": { "condition": "Eternal twilight", "temp": 59 }` (magic places, other planes).

The narrator line for each looks like:

```
Weather: Light rain, windy, 48°F (feels like 42°F), cool, 88% humidity. Underfoot: wet. Mid spring.
Weather (outside): Clear night, calm, 9°F, freezing, 70% humidity. Underfoot: snow on the ground. Mid winter. Inside, sheltered from the wind and rain: 62°F, cool.
Temperature here: 45°F, cold and still; no weather reaches this place.
```

### Custom climates

Add to `world.json` `climates` and use the id as a `climate`. Temperatures are in the world's `temperature_unit`. Preset files (`plugin/climates/*.json`) have the same shape in °C, without comments.

```jsonc
"climates": {
  "ashlands": {
    "name": "Ashlands",
    "daylight": { "summer": 14, "winter": 10 },      // hours of daylight on the longest and shortest day
    "seasons": {                                      // any names, any number
      "smoulder": {
        "months": ["April", "May", "June", "July", "August", "September"], // optional default months (a region's "seasons" overrides)
        "high": 95, "low": 70,                        // average afternoon high and pre-dawn low
        "humidity": 30,                               // average %
        "sky": { "clear": 5, "cloudy": 2, "storm": 1 }, // relative odds: clear, cloudy, overcast, fog, drizzle, rain, heavy_rain, storm
        "windiness": 1.5                              // 1 = normal; higher = windier
      },
      "ashfall": {
        "months": ["October", "November", "December", "January", "February", "March"],
        "high": 60, "low": 40, "humidity": 50,
        "sky": { "overcast": 4, "fog": 2, "drizzle": 1 }
      }
    }
  }
}
```

### Climate presets

Real-world Köppen climates. Use the id or the code.

| id | Köppen | What it is like | Real places |
|---|---|---|---|
| `cold_desert` | BWk | Dry all year; hot summers, freezing winters | Ulaanbaatar outskirts; Leh, India; Gobi Desert |
| `cold_steppe` | BSk | Semi-arid grassland; warm summers, cold snowy winters | Denver; Madrid plateau; Almaty |
| `dry_summer_continental_hot` | Dsa | Hot dry summers, cold snowy winters | Hakkâri, Turkey; Cambridge, Idaho |
| `dry_summer_continental_warm` | Dsb | Warm dry summers, snowy winters | Kayseri, Turkey; Flagstaff area; Tabriz |
| `dry_summer_subarctic` | Dsc | Short dry summers, long snowy winters | Upper Wasatch valleys; Kamchatka interior |
| `dry_summer_subarctic_extreme` | Dsd | Brief dry summer, brutally cold winter | Upper Kolyma, Siberia (rare) |
| `hot_desert` | BWh | Scorching days, cool nights, almost no rain | Cairo; Phoenix; Riyadh |
| `hot_steppe` | BSh | Semi-arid and hot; a short rainy season | Niamey, Niger; Monterrey, Mexico; Alice Springs |
| `humid_continental_hot_summer` | Dfa | Hot summers, cold snowy winters, rain all year | Chicago; Kyiv lowlands; Toronto-Windsor |
| `humid_continental_warm_summer` | Dfb | Warm summers, cold snowy winters (the "temperate" default) | Moscow; Montréal; Oslo |
| `humid_subtropical` | Cfa | Hot humid summers, mild winters, rain all year | Atlanta; Shanghai; Buenos Aires |
| `ice_cap` | EF | Permanently frozen | Antarctica interior; central Greenland |
| `mediterranean_cold_summer` | Csc | Cool dry summers, cold wet winters; rare highland pockets | Balmaceda, Chile; high Sierra Nevada valleys |
| `mediterranean_hot_summer` | Csa | Hot dry summers, mild wet winters | Rome; Athens; Los Angeles |
| `mediterranean_warm_summer` | Csb | Warm dry summers, mild wet winters, coastal fog | San Francisco; Porto; Cape Town |
| `monsoon_continental_hot` | Dwa | Hot wet summers, cold dry winters | Seoul; Beijing; Harbin outskirts |
| `monsoon_continental_warm` | Dwb | Warm wet summers, very cold dry winters | Vladivostok; Pyongyang uplands |
| `monsoon_subarctic` | Dwc | Short wet summers, long bitter dry winters | Chita, Russia; Mohe, China |
| `monsoon_subarctic_extreme` | Dwd | Short summer, the coldest dry winters on Earth | Oymyakon; Verkhoyansk |
| `monsoon_subtropical_hot_summer` | Cwa | Hot rainy summers, mild dry winters | Hong Kong; Delhi; Guangzhou |
| `oceanic` | Cfb | Mild and damp all year; cool summers, gentle winters | London; Paris; Seattle |
| `subarctic` | Dfc | Short mild summers, long hard winters | Anchorage; Fairbanks; Yakutsk outskirts |
| `subarctic_extreme` | Dfd | Short summers, extreme winters, deep frost | Yakutsk; Oymyakon region |
| `subpolar_oceanic` | Cfc | Cool, windy and wet; short cool summers | Reykjavík; Tórshavn, Faroe Islands; Ushuaia |
| `subtropical_highland` | Cwb | Spring-like all year at altitude; wet summers | Mexico City; Bogotá; Nairobi |
| `subtropical_highland_cold_summer` | Cwc | Cool high-altitude climate with a summer wet season | El Alto, Bolivia; Cusco highlands |
| `tropical_monsoon` | Am | Hot all year; a short dry spell, then torrential monsoon rains | Miami; Chittagong, Bangladesh; Conakry, Guinea |
| `tropical_rainforest` | Af | Hot and humid all year, rain almost every day | Singapore; Manaus, Brazil; Kisangani, DR Congo |
| `tropical_savanna` | Aw | Hot all year; wet summer, long dry winter | Darwin, Australia; Bangkok; Kinshasa |
| `tropical_savanna_dry_summer` | As | Hot all year; the rains come in winter instead | Chennai, India; Mombasa, Kenya; Fortaleza, Brazil |
| `tundra` | ET | Cold all year; a brief cool thaw | Nuuk; Barrow (Utqiaġvik); Svalbard |

## Editor mode (inspector and live edits)

In the map window (WorldScrawl GUI), the **Editor** button in the top bar switches to editor mode. It shows the whole world (every room and door, not just what the party has discovered) and works even with no chat open (it then shows the default world). Click a room, an area box, an exit line/stub, an exit in a room's exit list, or the ⓘ button by the breadcrumb (the current world/region/area) to open the inspector beside the map:

- **Resolved**: the live value of every field: the world file plus inheritance plus every map change in this chat. A room shows its own description, name, address and notes settings too. Each value says where it came from (`from file`, `from subregion`, `from region`, `default`, `from type "portal"`, or for an inherited barrier `from <room> side (<direction>)`, or `from message #N` when a map change in the chat set it).
- **Raw**: the JSON exactly as written in the world file (map changes never show here).
- **State**: the chat's clock (and the latest wait or sleep, with its message number), the weather at that room (temperature, feels-like, inside temperature) and, for an exit, whether its door is open, closed or locked right now.
- **Warnings**: the loader warnings that concern the clicked item (served by `GET /api/plugins/worldscrawl/inspect?target=…`; `GET …/inspect/index` lists rooms, doors and the warning count).

Rooms that a map change in this chat touched get a small orange dot on the map.

**Edit place**: with a WorldScrawl chat open in SillyTavern, the inspector's **Edit place** button (or **Edit subregion** / **Edit region**) opens a form showing that place's current data: name, description and settings, with yes/no settings as checkboxes and fixed choices as radio buttons (or a dropdown when there are four or more). Settings the place doesn't set itself show the inherited value greyed out with a "from subregion/region/world" tag; once you change one, a reset button puts it back to inheriting. A **Move to subregion** field moves the place to another subregion (pick it on the map, see below). Each exit is a small block that collapses to "direction → destination" (with **Collapse all** / **Expand all**); its X removes the exit and its way back, and **Add exit** at the top adds a new one to an existing place (with the name of the way back). Door and travel time are shared by both ends of an exit; the rest is per side. As you edit, the red/green diff shows below; **Submit** turns only what you actually changed into changes (inherited values are never copied in) and the SillyTavern tab adds a short hidden line to the chat, like "Map edit: Common Room: description rewritten". The model never sees that line, but the change applies from there on. Delete the line to undo the change. World files are never written. If something doesn't fit the map, the error shows and nothing is saved.

**Create, move and delete**: beside Edit, each inspector page has buttons for its level. The world page has **Create region** (a region, its first subregion and a starting place); a region has **Create subregion** (with its first place) and **Delete region**; a subregion has **Create place** (it needs at least one exit to an existing place), **Merge places**, **Move subregion** (to another region) and **Delete subregion**; a place has **Move place** (to any subregion) and **Delete place**. Deleting a subregion or region asks whether to delete what is inside or move it all into another one, which is how two subregions or regions are merged. Deleting or moving the last place of a subregion (or the last subregion of a region) also deletes that container: the map says so and offers **Confirm**, **Cancel** or **Add a place first** (which opens Create place there and comes back). The world's starting region can't be deleted. If a moved place or subregion has the same id as one already there, a rename box shows a suggested unique id (like `drowned_rat_common_room`); nothing is ever overwritten. A move leaves a redirect from the old address to the new one, like a merge, so a party standing there goes along; turning the change off takes the redirect away too. **Expand with AI** on a description or notes field asks the model for a richer text, showing it only the parent region and subregion notes and the names and first sentences of the places the exits lead to, never the whole world. Like Edit, every change is a hidden line in the chat: delete it to undo.

Click **Editor** again to return to the normal (play) map.

**Picking on the map**: every field that names a place, subregion or region (an exit's destination, Move / Merge / Delete targets, the wizards' "connect to", Entrance, Move to subregion) shows its current value with its full path (Region › Subregion › Place) and a **Choose…** button. Choose… puts the form aside, keeping everything you've typed, and turns the map into a picker: a big banner at the top says what you're picking ("Picking exit destination…") with a search box and **Cancel** (or Esc). The picker shows the whole world, ignoring fog of war, and opens at the field's current value, or else where you are. What can be chosen is highlighted; the wrong kind of thing, and the thing being edited, are dimmed. Double-click areas to go down a level as usual; once you're at the field's level, double-click a highlighted target and answer **Yes** to "Choose …?". The field fills in and the form comes back. Search results show full paths; clicking one jumps the map there.

## Map changes during play (fires, collapses, new doors)

Sometimes the story changes the map: a bridge collapses, a fire guts a room, or someone knocks a hole in a wall. WorldScrawl can record that change on the chat without editing your world files.

**For players**
- To flag a reply that changed the map, click the 🚩 flag button on it, or type `/ws-change` (you can add a note, like `/ws-change the roof caved in`). The narrator can also flag a reply on its own.
- WorldScrawl reads the last few messages and suggests a change, then shows a **Keep / Discard** card with a before/after view. You can move the start of the range on the card and click **Check again**.
- The card shows the change as a red/green diff per field (removed in red, added in green; unchanged fields behind **Show unchanged**, the raw data behind **Raw JSON**), and the diff follows the form while you edit. Click **Edit** on the card to change the suggestion before keeping it. Every part shows as a form: text boxes for descriptions and notes, places and areas picked from a list by name, a pick list for exits, and for a merge the places to merge (add or remove them), the place to keep or a new id, name, description and area. Every part also has a **lasts** box (for example `2d`; leave it empty for permanent). You can add or remove parts. **Keep edited** checks the whole change against the map. Problems show inline, and nothing is kept until it fits. What gets stamped is exactly what the form shows.
- A kept change has an **Edit** button too. Change it and click **Save change**, and it is re-stamped on the same message.
- Kept changes belong to that message and that swipe. If you delete the message, the change is undone. You can also click **Undo** on the card.
- If you want changes applied without the card, turn on **Auto-keep map changes** in the settings. You can also turn off the narrator's flag tags there.
- A change can be temporary (for example, "lasts": "2d"). It ends when that much game time has passed.

**For creators:** you don't need to do anything. Changes are stored in the chat, never in `worlds/`. In the map's Inspect panel, the **Changes** tab lists them, and Resolved shows "Changed by" for anything that was patched.

Patch ops (for the curious): `set_description`, `append_description`, `set_name`, `set_notes`, `append_notes`, `block_exit`, `open_exit`, `lock_exit`, `unlock_exit`, `break_exit`, `remove_exit`, `set_exit_description`, `update_area`, `remove_location`, `merge`, `discover`, `set_expandable`, `set_fields` (room/area settings; `null` resets to inherit), `set_exit` (per-side exit fields, the pair's door and shared travel time, a direction rename), `add_exit` (a new exit plus its way back, or `one_way`), `move_location`, `move_area`, `create_place`, `create_subregion`, `create_region`, `remove_area` (a place to another subregion of the same region). Any of them can take an optional `lasts`. Places are given as full addresses (`riverton:drowned_rat/common_room`), though a bare id that is unique is accepted and normalized. A brand-new place from a merge gets its id from its name (with `_2` and so on added if taken); you never type an id. `update_area` renames a region or subregion and/or rewrites its notes; ids never change. An exit pair shares its door state (block, open, lock, unlock, break, remove apply to both sides), while hidden, sight, sound and exit text are per side, and exit names change only through `set_exit`. Ops that change nothing (a rename to the same name) are dropped and shown greyed as "no change". The change call sees one step beyond the change (neighbors of the changed rooms or area) and may propose fixes to them on the same card.

### Discovery rooms

When the story opens a door that is not an exit, either one the room description mentions (say, one of the four guest rooms off the Drowned Rat's upstairs hallway) or one nobody described but that plausibly fits the room ("I open a door down the hall"), the narrator flags it (`ws_flag` with `action: "discover"`, or `[ws_flag: discover | which door]` in non-tools mode). One small model call writes the room behind it, given the current room, its neighbours one step out, and the subregion and region notes. If places nearby (up to 3 steps) are not yet connected to the room, they are offered as short keys too, and the model may answer `{"existing": key, ...}`: then only a door pair to that place is added (`add_exit`). Otherwise the engine adds a `create_place` edit: a new room (its id made from the name, e.g. `end_guest_room`) and one door pair to it, as if it had always been there. Nothing else changes: no notes, no rewrite of the hallway. It is stamped at once; tick **Ask before adding a discovered room** in the settings to get the Keep / Discard card instead. Like any change it can be turned off and on again; turning it off while standing in the room moves the party back out. When the player types something like "I open a door down the hall" and no exit matches, the intent check picks **try another door**; the narrator is then told to open it and flag a discovery only if such a door fits the place, and otherwise to say there is none. Rooms where `"expandable"` is false (set on the room or inherited, see the world format) refuse discoveries. In the map editor, **Allow / forbid discovered rooms** (`set_expandable`) sets it on a room, subregion (`region:subregion`) or region to `true`, `false` or `inherit`.
