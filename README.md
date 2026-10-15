# WorldScrawl

A persistent, static world map for SillyTavern roleplay. A small FastAPI server holds the map as JSON files, and a SillyTavern extension gives the model two tools:

- `ws_look`: the current location's name, description and exits.
- `ws_move(direction)`: go through an exit; returns the new location, or an error listing the valid directions.

This is version 0.1: static map only. Nothing is generated or created at runtime.

## Layout

```
app/world.py        loads + validates the world files
app/main.py         FastAPI server (stateless)
world/world.json    { "start_region": "riverton" }
world/regions/      one JSON file per region
extension/          the SillyTavern extension (manifest.json, index.js)
tests/              pytest tests; tests/e2e/ is a headless SillyTavern test
```

## World files

`world/world.json`:

```json
{ "start_region": "riverton" }
```

`world/regions/<region_id>.json`:

```json
{
  "id": "riverton",
  "name": "Riverton",
  "start": "tavern",
  "locations": {
    "tavern": {
      "name": "The Drowned Rat",
      "description": "...",
      "exits": [
        { "direction": "out", "to": "square", "description": "optional" },
        { "direction": "east", "to": "hollowmere:gate" }
      ]
    }
  }
}
```

Rules (checked when the server starts; it refuses to start and says what's wrong otherwise):

- Region and location ids are lowercase slugs: letters, digits and single underscores (`old_mill`).
- The region `id` must match its file name.
- Location ids only need to be unique within their region. A full address is `region:location` (`riverton:tavern`).
- An exit's `to` is a bare id for the same region or a full address for another region. Every target must exist.
- No duplicate keys anywhere (two `"tavern"` entries is an error, not a silent overwrite), and no duplicate directions in one location.
- `start_region` and each region's `start` must exist.

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

- `GET /start` returns the start location.
- `GET /location/{address}` returns `{ address, region: {id, name}, name, description, exits: [{ direction, to, to_name, description? }] }`.
- `POST /move` with `{ "from": "riverton:tavern", "direction": "out" }` returns the new location, or 400 with `{ "detail": { "error", "valid_directions" } }`.
- `GET /health` returns counts and the start address.

Set `WORLDSCRAWL_WORLD_DIR` to use a world folder somewhere else.

## Tests

```bash
pip install -r requirements-dev.txt
pytest
ST_SRC=/path/to/SillyTavern tests/e2e/run.sh   # headless: real ST 1.19 + fake model + Chrome (needs playwright-core)
```

## Movement (v0.2): the engine moves, the model narrates

By default the model never touches the map:

- **Click an exit** in the "Exits:" line under the latest reply, or type `/ws-go north`. The extension moves the party, adds a short note ("*The party goes north.*") and asks the model to narrate the arrival.
- **Typed movement** ("let's head to the docks"): before each reply the extension asks the model one multiple-choice question, "Which of these exits does the player mean: south, north, none?". Only an exact answer from that list moves the party; anything else means no move. Toggle: "Understand typed movement".
- Every turn the model gets the current location, its exits and what just happened as authoritative facts, and is told not to move the party or invent exits.
- `/ws-exits` shows the current exits.
- The old `ws_look` / `ws_move` tools are an off-by-default setting.
