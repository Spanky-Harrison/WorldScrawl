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
- Optional exit `"view"`: `"open"` (default), `"closed"` (default for hidden/obscured exits) or `"none"`; anything else is an error. **open**: the room prompt gets a one-line glimpse of the room beyond ("Looking out, you can see Village Square: <first sentence>"; "Through the gate, you can see ..." for named exits) and it counts as seen. **closed**: no glimpse; listening at it gives only a faint, muffled hint. **none**: nothing.
- Doors: a closed exit can be opened and closed (both sides share the door), by the typed intents "open a door" / "close a door", by peeking through it, or by `/ws-open <dir>` / `/ws-close <dir>`. The change is stamped on the message (swipes keep it, deleting undoes it). An opened door counts as `view: open`. Doors shut themselves: optional `"stays_open": true|false` on a region, a subregion or an exit (per door, the same from both sides: an exit-level `stays_open` on either side wins, false if the two sides disagree; otherwise the door stays open only if both rooms inherit true from their subregion/region; default false); a door that doesn't stay open counts as closed again once the party is in neither of the two rooms it connects. Closing explicitly always works. These fields are optional and Save world never adds them.
- Optional location `"views": ["streets/square", ...]`: rooms visible from here with no way through (windows). They take priority over the chat's own view links (below).
- Doors are paired at load time: a flagged exit and its return exit (the exit in its destination room pointing back) share an opaque `door` id, so walking through either side reveals both. A flagged exit with no return exit is allowed (one-way door) and logs a warning at load.
- Notes sent to the model: region notes, then subregion notes, then the location description (which wins if they disagree).
  - Subregion `"inherit_notes": false` drops the region notes for all its rooms.
  - A location's `inherit_region_notes` / `inherit_subregion_notes` override that when present (true/false). Missing = follow the subregion.
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
- **Narrative digging** (typed moves): "I smash out the window" can open a new exit. The intent check has a `new opening` choice (offered only when the message uses a breaking-through word or phrase: smash, break/broke, burst, bash, blast, shatter, breach, dig/dug, carve, hack/cut/punch through, kick in/down/through, knock down/through, tear down/through, make/open a hole; bare "tunnel" or "hole" don't count, and a stray "new opening" answer is handled like any other unreadable answer). Then small questions, each validated and retried alone (2 tries), all on the same connection as the intent check:
  1. *Where does this opening most likely lead?* A numbered list of rooms up to 3 steps away over the map (nearest first, max 12; name, area, first sentence of the description only, never which door leads where) plus `somewhere new`.
  2. *What is the opening called from this side?* north/south/east/west/up/down or a 1-2 word name, not one already used on either side.
  3. For somewhere new: a 2-3 word name, then a one-sentence description.
  4. *Does the player clearly stay on this side (only making the opening, looking or reaching through)? Reply yes or no.* Only a clean "yes" keeps the party where they are; anything else moves them through the new exit in the same turn.
  The change (and the move, if any: dig first, then location = destination, which makes it discovered) is stamped on the player's message, like a move: swiping/regenerating the reply keeps it; deleting the message undoes it. If an answer never validates, nothing changes, a notice says "Nothing gave way", and the narration is told the attempt failed.
- **Looking** (typed moves): the `look` choice is offered when the message uses a whole word like look/peer/peek/gaze/glance/listen/watch/see. Then small numbered questions (validated, 2 tries each): *What is the player looking at or listening to?* (the room's exits by label, never an unrevealed hidden exit, plus `out a window or opening with no exit`). An open (or opened) exit shows the room beyond; a closed one asks *Is the player only listening at it (not looking through, peeking or opening it)?* yes = a faint hint only, otherwise the door is opened (stamped) and the room shown; `none` or an unrevealed obscured exit shows nothing. A window uses the location's `views`, else an earlier view link, else asks *Which place can they most likely see?* from the nearby-room list (`POST /nearby`) and stamps a `view_link` change so the same place is seen next time (Save world writes it into `views`). The party never moves. Seen places are known for "I go to X" when a route through visited rooms exists; routes and fast travel only pass through rooms the party has stood in.

- **Save world** (`/ws-save-world [switch=false] [knowledge=true] <name> [--knowledge]`, or the settings button) renders the chat's world plus its changes into a new world. Map changes are always baked in. **Pristine** (default) writes no knowledge, so new chats start fresh at the world's start. **Include this chat's discoveries** ("with knowledge") also writes `knowledge.json` (places stood in, places seen, revealed doors, current location as the start). A new chat on that world seeds those from it on message 0 (seed + later stamps; swipes can't remove the seed).
- **Rebase:** every save posts a system message ("[Engine: world saved as \"Name\". This chat now uses it.]"). With switch on (default) that message carries a rebase stamp `{id, version, rebase: true, at, from}`. From then on the chat is built on the new world and only changes stamped after that message are replayed (earlier ones are baked in). Locations, known places and revealed doors keep working (same addresses). Deleting or swiping away that message puts the chat back on the previous world with its changes.
- Missing rooms, exits or doors in stamps (e.g. edited out of the map) are skipped with a console warning. If the current location itself is gone, the party is put at the world's start with a short system notice (delete it to undo).

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

- Rooms are offered to the model as "Name (Building)", e.g. "Common Room (The Gilded Goose)". Building and region names work too ("go to the Drowned Rat"): you arrive at the building's entrance, or at a room of that building you've already been in if it's nearer (e.g. the Drowned Rat's stable, through the stable gate on Market Lane). The Drowned Rat now has a common room, upstairs rooms, a courtyard, kitchens and a stable.
- If the model answers "elsewhere" or "unclear", the extension checks your words against known places itself (case-insensitive, word-level: "upstairs" matches "Upstairs Rooms"). One match: you go there. Several: "Which one do you mean?" with buttons. Already inside the named building/region: "You're already in X." None: "You're not aware of such a place."
- Locations are cached in memory (cleared on page reload or when the server URL changes), so each place is fetched from the server once.

## For card authors: "Start your adventure"

Put `[ws-start]` anywhere in a character's greeting (or alternate greetings). WorldScrawl shows a **Start your adventure** button there instead of the marker; clicking it sends "I look around" as your first message, so the model only runs when you choose to start. The greeting's stored text isn't changed, and the button disappears once the chat has more than the greeting.

`/ws-known` lists the places this chat knows, in two groups: "Been there" and "Seen" (places spotted through exits or windows but never visited). It never names hidden-exit destinations.

**Looking at closed doors.** When you look at a closed door, the engine asks which of four things you did: listen (only faint sounds), peek (you glimpse the room beyond, but the door stays shut and the peek is recorded on the message as `worldscrawl_peek`), open (the door opens), or just look (you're told the door is closed). The narrator is told to mention every exit only when you arrive somewhere or explicitly look around. Exits whose destination is obscured are named only by their label.
