# NPC design (WorldScrawl)

Status: design only, no code. Covers phases 1-4 of NPC support.

## Vision

The engine holds the state, and each reply gets only the context it needs. The narrator never reads huge chat histories or lorebooks. It gets:

1. recent chat for tone and flow,
2. a short scene summary kept by the engine (later, with the story engine),
3. context slices: where we are (the map already does this), who's here, and what about them matters for *this* reply.

**Phase 1 does not prune chat history.** The full history is sent as it is today; phase 1 only *adds* NPC context, and the detail tiers limit how much NPC detail goes in. The recent-window setting (a message count plus a length cap) and real history pruning are deferred to the story engine.

NPCs follow the same pattern the map uses: scenery becomes real when touched, grows as play goes on, and every change is undoable.

## Ground rules (same as the map)

- **Stateless server.** Nothing about an NPC changes on the server during play. Every change (creation, a new fact, a "seen" mark, a coverage change, a memory highlight) is a stamp on the message where it happened, per swipe. The server applies the stamped changes on each request, just like map patches (`PATCH_KEY`) and location stamps. Deleting or swiping a message undoes its changes.
- **Simple JSON for creators.** A quick NPC is one sentence. Everything else is optional with defaults.
- **Pick-one prompts** use text keys with lenient matching, like the existing intent and direction questions in `plugin/prompts/default.json`.
- **UI reuses existing patterns:** the Keep / Adjust / Discard card (as in room discovery) and the Edit / Turn off / Undo bar (as in "Map changed here").
- **Actor placeholders** are our own: `{{party}}` (with `{{who}}` as an alias), not SillyTavern's `{{user}}`/`{{char}}`.

## Lifecycle

| Level | What it is | How it gets there |
|---|---|---|
| **Scenery** | Not real. A word in a room description ("a farmer works the field"), like the upstairs doors of the Drowned Rat. No record. | Written by the creator or narrator. |
| **Stub** | Name and one line (or more, see below). A real record. | Hesitant creation, see below. Keep stamps an `npc_create` on that message. |
| **Full** | Detailed description, features, memory, schedule. | Grows through stamps as play adds detail. Creators can also author full NPCs directly. |

### Hesitant creation

- **Passersby stay scenery:** no record, no card. Asking the barmaid for a drink does not create an NPC.
- **Suggestion:** after about **3 replies involving the same person**, the engine suggests a **Keep / Adjust / Discard** card.
- **Explicit:** the player can ask at any time with `[remember]` in a message (e.g. "I'm going to [remember] Maren") or `/ws-npc`.
- **A "no" is remembered for the current scene** (stamped on the message, so it's undoable), and the card isn't offered again for that person until the scene changes.
- **Keeping reads back, not a blank stub.** Keeping pulls the name, appearance and stated facts from **every message since the person first appeared**, like the flag step reading a range of messages. The record starts with what the story already said.
- **No stand-ins.** A saved NPC appears only via their schedule, by following the party, or when the player seeks them by name. They are never reused as a random stranger ("a guard" is never secretly the guard you saved last week).
- **One-offs get a sighting, not a schedule.** A saved NPC met once gets a "seen at" entry instead of a schedule: `{ place, time_of_day, chance }`, the place and time of day they were met. They are still never auto-picked as an anonymous extra. This avoids writing full schedules for incidental NPCs who may narratively be somewhere that isn't on the map.
  - **Chance:** roughly **50%** when the party is in that area around that time of day, **lower (about 10%)** at other times.
  - **By name:** when the player looks for them by name, they get a re-roll.
  - **Deterministic rolls:** the sighting roll is seeded from the NPC id, the place and the game day (from `clockAt`), so swiping or regenerating can't flip the result. The by-name re-roll has its own seed, **per NPC + game day (not per attempt)**: repeated searches on the same day get the same answer, so it's effectively one search per day.
  - **Stamped:** a successful appearance is stamped on the message (so deleting it undoes the appearance).
  - A one-off who gets a real schedule later (written by a creator or via Export to cast) stops using the sighting.

  ```json
  { "id": "maren", "name": "Maren", "line": "A traveling knife-grinder with a squeaky cart.",
    "seen_at": { "place": "riverton/market-square", "time_of_day": "morning", "chance": 0.5 } }
  ```

### Following

A simple **`following`** tag in phase 1: an NPC told to come along (stamp) is present wherever the party is, overriding their schedule, until told to stay (another stamp, which also puts them back on their schedule at that place, or at their normal entry).

**Invented details.** The model will make up small facts (a scar, a sister's name, a favorite drink). With the long history gone, these must be saved or they get contradicted later. After each reply, the same flag step the map uses (`ws_flag`) lets the narrator report new facts about present NPCs; the engine stamps them as `npc_fact` on the reply. A "Character changed here" bar (Edit / Turn off / Undo) shows them, like "Map changed here".

## Detail tiers in prompts

| Tier | Sent when | Contents |
|---|---|---|
| **Present** | NPC is in the scene but not the focus | Name, 1-2 sentence description, current activity (from schedule) |
| **Focused** | Player `[look]`s at or talks to them | Full visible appearance, manner, voice, `met` status, relevant memory highlights |
| **Deep** | The conversation goes there (history, secrets, relationships, what they think of the player) | Deep fields, only the relevant ones |

The engine decides tiers **before generation**, as part of the per-message intent call we already make: one extra pick-one question ("who is the player addressing / looking at?", keys are NPC names, lenient matching, plus `nobody`) and a depth question (`present` / `focused` / `deep`). Start with simple rules: who the player named, touched or addressed.

**Backup:** the narrator gets a rare `need_detail` tool (npc id + what it needs). Each call is another round trip, so prompts tell it to use it only when it would otherwise invent something important.

## Context slicing (phase 1)

Slicing is the core of the vision, so it ships in phase 1 even while NPCs are only stubs. Phases 2-3 add layers to the same mechanism instead of rewiring it.

Per reply the engine works out:
- **Who's present:** NPCs whose current schedule entry resolves to the scene's place (plus any NPC tagged `following`). Only kept NPCs count; unsaved people are just part of the recent chat.
- **Who's in focus:** from the intent call.
- **Which memory notes go in:** only for focused NPCs, or present ones the reply concerns.

**Scene focus** reuses the existing idea: focus follows the player by default (the party's location), and can move to an NPC-only scene ("meanwhile, at the mill"), where the slice is built for that place instead.

The prompt gets the slices through new placeholders in `default.json` (e.g. `{{npcs_present}}`, `{{npc_focus}}`), documented the same way as the existing ones.

## Memory

- **`met`** flag first: has this NPC met the party? (stamp)
- **Highlights:** short notes like "met the party at the inn; owes them a favor". Added by the flag step as `npc_memory` stamps, kept tight (a cap per NPC, oldest/least important summarized away later).
- Fed only when the NPC is focused, or when the reply clearly concerns them.

## Body and features (phase 2)

A defined body object with a small fixed list of areas: `head`, `face`, `neck`, `chest`, `back`, `arms`, `hands`, `waist`, `legs`, `feet`. A feature with no area defaults to `body` (always visible / general).

Each **feature** has:
- `short`: "a rose tattoo on his chest reading CAPTAIN"
- `long` (optional): the elaborate version, only sent when the player looks at it or asks for full detail
- `area`
- a **seen** mark (stamp) once the player has seen it

**Coverage** in v1 is a simple list of covered areas (a shirt covers `chest`, `back`, `arms`). Coverage changes (shirt off, torn sleeve, new outfit) are `npc_coverage` stamps, so the next reply doesn't snap back to the default outfit.

**Assembled description:** the engine builds the description from uncovered features (short text, long text when focused on that feature). Covered but seen features are sent as "a tattoo under his shirt (seen before)" so the narrator doesn't treat it as new. Covered and unseen features are not sent.

## Wardrobe (phase 3)

An extendable library of garments, each with materials, colors, coverage (areas) and tags for style, theme and type (`office`, `stylish`, `farmwork`, ...). Armor and exposure protection come later.

- When an NPC is looked over in detail, the model picks an outfit **by tags**, and the engine assembles it from the library (stamped).
- Tags inform reactions and descriptions: an outfit is "stylish and office-appropriate" because its pieces carry those tags.
- Phase 3 replaces the plain coverage list with the outfit's garments; features are written the same way.

## Storage

The cast belongs to a world but is separable:

```
worlds/riverton/
  ...location data...
  cast/
    marta-ferris.json
    old-tom.json
```

One file per NPC. Copy the `cast/` folder out as a set, or any single file. Base records are clean templates; everything that changes in play is stamps.

**Export to cast:** an NPC who grew during play (the farmer who got a name, a tattoo and a history) exists only as stamps in that chat. "Export to cast" writes his current state (base record + all active stamps) into a clean record file, either into the world's `cast/` or a standalone file. This is the same idea as the existing "save chat as a new world" render, scoped to one NPC.

## Schedule stub (phase 1)

A schedule is a list of entries: `{ place, activity, from?, to? }`. A stationary NPC has one entry with no times. This is where "where they show up and what they're doing" lives from day one, even before anyone moves.

**Place lookups go through the same redirects player positions use.** Map patches can merge, rename or move rooms; the engine already resolves stamped player locations through those redirects (`relocateMap`, `resolvePosition`). Schedule entries resolve the same way, so an NPC whose tavern got merged into the next room still shows up there.

**Failures, in order:**
1. Id resolves (directly or via redirect): use it.
2. Id points at an **expired** place (removed by a patch, e.g. the mill burned down): fall back to the NPC's **next valid entry**.
3. Id is **truly missing** (never existed in this world, e.g. a cast imported from another world): the entry is marked **broken**, never a crash. Broken entries show in the editor; an NPC with no valid entry is off-map until fixed.

A later **cast import tool / schedule wizard** helps adapt broken entries to a new world.

### Map changes and schedules (phase 4)

When a map change (patch) touches a place, a small call checks the schedule entries pointing there and picks, per entry: `keep` / `change activity` / `move` (text keys, lenient matching). The results are **schedule stamps that depend on the causing map change**: turning that change off, undoing it, or letting it expire removes them automatically through the dependency check, like other dependent changes. Example: the Drowned Rat burns down, so Hesk's entry changes to "standing in the ruins" instead of "pouring drinks"; undo the fire and Hesk is back behind the bar.

Real movement over time comes in phase 4, using the game clock (`clockAt`) to pick the active entry and the snapshot cache (`snapcache.mjs`) to keep per-reply resolution cheap.

## Phases

1. **Records and slicing:** NPC records (stub/full), placement, hesitant creation (suggested Keep card after ~3 replies, `[remember]` / `/ws-npc`, read-back from first appearance, no stand-ins), `following` tag, invented-detail stamps, met flag and memory highlights, context slicing (present/focus/memory), cast files, Export to cast, schedule stub with redirect-aware validation, one-off sightings with deterministic seeded rolls.
2. **Body and features:** body areas, features with short/long text, seen marks, simple coverage and coverage stamps, assembled descriptions.
3. **Wardrobe:** garment library, tags, outfits by tags, tag-informed reactions.
4. **Schedules and life off-screen:** NPCs move between places over game time, map changes re-check affected schedule entries (dependent stamps), NPC-only scenes as a common tool.

## Future work (not designed yet)

- **Hostile NPCs, and any NPC that needs stats once stats exist,** are an exception to hesitant creation. They'll likely need a record right away, even as passersby (a mugger in the street).
- **Story engine:** recent-window setting (message count plus length cap), history pruning, and the scene summary.

## JSON examples

A one-sentence NPC (`worlds/riverton/cast/old-tom.json`):

```json
{ "id": "old-tom", "name": "Old Tom", "line": "A stooped farmer who never stops complaining about the river.", "schedule": [{ "place": "riverton/south-field", "activity": "hoeing turnips" }] }
```

A full NPC:

```json
{
  "id": "marta-ferris",
  "name": "Marta Ferris",
  "line": "The Drowned Rat's sharp-eyed landlady, forty-odd, sleeves always rolled.",
  "manner": "Brisk, dry humor, softens around children.",
  "voice": "Low, clipped; calls everyone 'love'.",
  "deep": {
    "history": "Ran with river smugglers in her twenties.",
    "secrets": ["Still fences goods for the Kettle crew."],
    "relationships": { "old-tom": "Owes him money; avoids him." }
  },
  "body": {
    "features": [
      { "id": "tattoo", "area": "chest", "short": "a rose tattoo reading CAPTAIN",
        "long": "Three roses wound around a ship's wheel, CAPTAIN inked in faded navy capitals across the middle." },
      { "id": "scar", "area": "hands", "short": "a pale scar across her left knuckles" }
    ],
    "covered": ["chest", "back", "arms"]
  },
  "schedule": [
    { "place": "riverton/drowned-rat/taproom", "activity": "pouring drinks", "from": "16:00", "to": "02:00" },
    { "place": "riverton/drowned-rat/upstairs", "activity": "asleep" }
  ]
}
```

A stamp (on the message where it happened, per swipe, next to location and patch stamps):

```json
{ "npc": [
  { "type": "npc_fact", "id": "marta-ferris", "field": "deep.relationships.party", "text": "Thinks the party is trouble, but useful." },
  { "type": "npc_seen", "id": "marta-ferris", "feature": "tattoo" },
  { "type": "npc_coverage", "id": "marta-ferris", "uncover": ["arms"] },
  { "type": "npc_memory", "id": "marta-ferris", "met": true, "note": "Gave the party a free room in exchange for a favor." }
] }
```

## Open questions

1. **Suggestion threshold:** is ~3 replies right, and what counts as "the same person" before they have a name (the engine matching "the barmaid" across replies)?
2. **Scene boundary for a remembered "no":** a location change, a time skip, or something the story engine decides later?
3. **Read-back range:** how far back can "since they first appeared" go in a long chat, and how is the first appearance found (asked of the model, or the earliest message mentioning them)?
4. **Memory cap:** how many highlights per NPC before older ones are summarized, and who summarizes?
5. **Depth decision:** a separate pick-one question, or folded into the existing intent call to save a round trip?
6. **Export conflicts:** exporting an NPC whose id already exists in `cast/`: overwrite, version, or new id? And ids for NPCs created in play (name slug with a suffix on clashes?)
7. **Following and stay:** when told to stay somewhere off their schedule, do they stay there indefinitely, or drift back to their schedule (phase 4)?
8. **Expired-place fallback:** if every entry is expired, is the NPC off-map, or placed at the nearest surviving neighbour like the player resolver does?
9. **Sighting areas and times:** what counts as "in that area" (the same room, the same subregion?) and "around that time" (the same time-of-day bucket, or a window in hours)? Are 50% and 10% fixed, or per-NPC/creator settings?
10. **Sighting place expired:** if a one-off's sighting place is merged or removed, follow redirects like schedules, and if it's truly gone, does the NPC become "by name only"?
11. **Phase 4 schedule check:** run the check when the map change is made (one call per change) or lazily the first time an affected NPC would appear?
