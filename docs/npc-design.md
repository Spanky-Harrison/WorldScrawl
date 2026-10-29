# NPC design (WorldScrawl)

Status: design only, no code. Covers phases 1-4 of NPC support.

## Vision

The engine holds the state, and each reply gets only the context it needs. The narrator never reads huge chat histories or lorebooks. It gets:

1. a short window of recent messages (for tone, flow, who just said what),
2. a short scene summary kept by the engine,
3. context slices: where we are (the map already does this), who's here, and what about them matters for *this* reply.

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
| **Stub** | Name and one line. A real record. | The player interacts with scenery. The engine proposes an NPC; a **Keep / Adjust / Discard** card asks (incidental interactions can be discarded and stay scenery). Keep stamps an `npc_create` on that message. |
| **Full** | Detailed description, features, memory, schedule. | Grows through stamps as play adds detail. Creators can also author full NPCs directly. |

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
- **Who's present:** NPCs whose current schedule entry resolves to the scene's place (plus any NPC stamped as following the party).
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

Real movement over time comes in phase 4, using the game clock (`clockAt`) to pick the active entry and the snapshot cache (`snapcache.mjs`) to keep per-reply resolution cheap.

## Phases

1. **Records and slicing:** NPC records (stub/full), placement, stub creation with the Keep/Discard card, invented-detail stamps, met flag and memory highlights, context slicing (present/focus/memory), cast files, Export to cast, schedule stub with redirect-aware validation.
2. **Body and features:** body areas, features with short/long text, seen marks, simple coverage and coverage stamps, assembled descriptions.
3. **Wardrobe:** garment library, tags, outfits by tags, tag-informed reactions.
4. **Schedules and life off-screen:** NPCs move between places over game time, NPC-only scenes as a common tool.

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

1. **Stub creation prompt:** always ask with a card, or auto-keep when the player names or addresses someone and only ask for incidental ones?
2. **Memory cap:** how many highlights per NPC before older ones are summarized, and who summarizes (an extra call on the flag step?).
3. **Scene summary:** how is the engine's short scene summary kept stateless: stamped per message, or rebuilt from the recent window each time?
4. **Recent window size:** fixed message count, token budget, or a setting?
5. **Depth decision:** is one extra pick-one question per message enough, or do we fold it into the existing intent call to save a round trip?
6. **Export conflicts:** exporting an NPC whose id already exists in `cast/`: overwrite, version, or new id?
7. **NPC ids from play:** generated from the name (slug) with a suffix on clashes?
8. **Following NPCs:** in phase 1, can an NPC join the party (a `follows` stamp overriding the schedule), or wait for phase 4?
9. **Expired-place fallback:** if every entry is expired, is the NPC off-map, or placed at the nearest surviving neighbour like the player resolver does?
