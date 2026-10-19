# WorldScrawl

A persistent, static world map for SillyTavern roleplay. A small FastAPI server holds the map as JSON files, and a SillyTavern extension gives the model two tools:

- `ws_look`: the current location's name, description and exits.
- `ws_move(direction)`: go through an exit; returns the new location, or an error listing the valid directions.

This is version 0.1: static map only. Nothing is generated or created at runtime.

## Layout

```
app/world.py        loads + validates the world files
app/main.py         FastAPI server (stateless)
worlds/riverton/world.json    { "start_region": "riverton" }
worlds/riverton/regions/      one JSON file per region
extension/          the SillyTavern extension (manifest.json, index.js)
tests/              pytest tests; tests/e2e/ is a headless SillyTavern test
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
  "entrance": "streets/square",
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

- `entrance` (optional): the room you arrive in when travelling to a building/area by name (subregion: a room id, default its first room) or to a region by name (region: `sub/loc`, default the region's start). Checked when the server starts.
- Full address: `region:subregion/location` (`riverton:drowned_rat/common_room`).
- Exit `to`: `loc` = same subregion, `sub/loc` = same region, `region:sub/loc` = another region. Every target must exist.
- Optional exit flags `obscured` / `hidden` (true/false). `obscured` = you can see the door but not what's behind it: it is listed by its label only ("trapdoor", "grate") until the party has walked through that door, from either side. `hidden` is reserved for true secret doors (not listed at all until found, which needs per-chat state); **for now `hidden` behaves exactly like `obscured`**.
- Typed moves: when the model picks an exit the player didn't refer to (its word or a word of its description, e.g. "down the stair" for the grate), an unrevealed hidden/obscured exit is rejected (normal notices: "You're not aware of such a place." for unknown places), and a normal exit loses to a single known place the player named that it doesn't lead to (that place is travelled to instead).
- Doors are paired at load time: a flagged exit and its return exit (the exit in its destination room pointing back) share an opaque `door` id, so walking through either side reveals both. A flagged exit with no return exit is allowed (one-way door) and logs a warning at load.
- Notes sent to the model: region notes, then subregion notes, then the location description (which wins if they disagree).
  - Subregion `"inherit_notes": false` drops the region notes for all its rooms.
  - A location's `inherit_region_notes` / `inherit_subregion_notes` override that when present (true/false). Missing = follow the subregion.
- Ids are lowercase slugs (`old_mill`). No duplicate keys anywhere, no duplicate directions in one location. The server refuses to start and says what's wrong otherwise.

## Setup on Windows (PowerShell)

Assuming the repo is cloned to `C:\WorldScrawl` (change the paths if not):

```powershell
cd C:\
git clone https://github.com/Spanky-Harrison/WorldScrawl.git
cd C:\WorldScrawl
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
uvicorn app.main:app --host 127.0.0.1 --port 5100
```

If `Activate.ps1` is blocked, run `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` once. Next time you only need:

```powershell
cd C:\WorldScrawl
.\.venv\Scripts\Activate.ps1
uvicorn app.main:app --host 127.0.0.1 --port 5100
```

Check it at http://127.0.0.1:5100/start. Interactive API docs are at http://127.0.0.1:5100/docs.

### Install the extension

Link the `extension` folder into SillyTavern's extensions folder (a junction, so `git pull` updates it):

```powershell
New-Item -ItemType Junction -Path "C:\sillyTavern\SillyTavern-Launcher\SillyTavern\data\default-user\extensions\WorldScrawl" -Target "C:\WorldScrawl\extension"
```

Then reload SillyTavern (Ctrl+F5). Under Extensions you'll see a **WorldScrawl** panel with the server URL (default `http://127.0.0.1:5100`) and a **Test connection** button.

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

## Worlds

Every folder in `worlds/` with a `world.json` is a world; its id is the folder name (letters, digits and dashes only). `worlds/riverton` (the former `world/` folder) is the default world (`WORLDSCRAWL_DEFAULT_WORLD` changes it; `WORLDSCRAWL_WORLDS_DIR` points at another worlds folder; the old `WORLDSCRAWL_WORLD_DIR` still serves one folder as world `default`). `world.json` may have an optional `"name"`. Each world has its own map version. Saved worlds other than riverton are ignored by git.

- Every map endpoint takes `?world=<id>` (default world if omitted). Bad ids are rejected (400), unknown ids are 404.
- `GET /worlds` → `{default, worlds: [{id, name, start_region, start, map_version, has_knowledge}]}`.
- `GET /worlds/{id}/knowledge` → `{knowledge}`: the saved chat knowledge, or null.
- `POST /worlds/render {base?, id, name?, changes: [...], overwrite?: false, knowledge?: {location, stood, seen, doors}}` writes a full new world folder: the base world's files with `changes` applied, in the normal hand-written format (no derived data). It's loaded right away. It refuses an existing id (409) unless `overwrite` is true. With `knowledge` it also writes `knowledge.json` next to the region files (entries that don't exist in the new world are dropped).
- `POST /move` and `POST /travel` accept `changes` (this chat's world changes), applied for that request only.
- Change types (`app/changes.py`; anything else is rejected): `{type: "add_exit", from, direction, to, description?}`, `{type: "remove_exit", from, direction}`.

**Per-chat world state** lives in message stamps (the server never stores gameplay state):
- A new chat stamps its world (`{id, version}`) on the greeting, taken from the "World for new chats" setting (default: the server's default world). Chats with no world stamp use the default world. If the server's map version differs from the chat's, a warning (and one toast) is shown, but nothing is blocked.
- `/ws-dig <direction> <known place>` and `/ws-removeexit <direction>` post a short system message ("[Engine: a passage north to Village Square was opened.]") carrying the change. Deleting that message undoes the change.
- **Save world** (`/ws-save-world [switch=false] [knowledge=true] <name> [--knowledge]`, or the settings button) renders the chat's world plus its changes into a new world. Map changes are always baked in. **Pristine** (default) writes no knowledge, so new chats start fresh at the world's start. **With knowledge** also writes `knowledge.json` (places stood in, places seen, revealed doors, current location as the start). A new chat on that world seeds those from it on message 0 (seed + later stamps; swipes can't remove the seed).
- **Rebase:** with switch on (default), the latest message gets a rebase stamp `{id, version, rebase: true, at, from}`. From then on the chat is built on the new world and only changes stamped after that message are replayed (earlier ones are baked in). Locations, known places and revealed doors keep working (same addresses). Deleting or swiping away that message puts the chat back on the previous world with its changes.
- Missing rooms, exits or doors in stamps (e.g. edited out of the map) are skipped with a console warning. If the current location itself is gone, the party is put at the world's start with a short system notice (delete it to undo).

## Tests

```bash
pip install -r requirements-dev.txt
pytest
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
