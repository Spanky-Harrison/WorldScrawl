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
- **Actor placeholders** are our own: `{{party}}` (with `{{who}}` as an alias), rendered from the player's group (see *Actors, not a party*), not SillyTavern's `{{user}}`/`{{char}}`.

## Actors, not a party

There is never a single "party" entity. The player and companions are **individual actors**, each with an id like an NPC (the player is the default actor, `player`). A "party" is just actors grouped together via **following**: whoever is following the player is with them.

- **Phase 1 prerequisite:** today's single party position stamp becomes **per-actor positions**, with the player as the default actor.
- **This refactor ships as its own PR before any NPC code, with zero behavior change.** Every existing test passes, and old chats' position stamps (no actor id) load as the player's position.
- `{{party}}` is rendered from that group (the player plus whoever is following them).
- "The party" in this doc is shorthand for the player and whoever is following them, never a stored object.

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
- **No stand-ins.** A saved NPC appears only via their schedule, by following the player, or when the player seeks them by name. They are never reused as a random stranger ("a guard" is never secretly the guard you saved last week).
  - **Future story-engine hook:** a story engine (never the default engine) may *deliberately* place a saved NPC as an anonymous figure ("a guard") and reveal them later, as a twist. By default, saved NPCs are never reused as strangers by accident.
- **One-offs get a sighting, not a schedule.** A saved NPC met once gets a "seen at" entry instead of a schedule: `{ place, hour, chance }`: the place and the hour they were met, and the peak chance. They are still never auto-picked as an anonymous extra. This avoids writing full schedules for incidental NPCs who may narratively be somewhere that isn't on the map.
  - **Graduated by hour.** The time they were met rounds down to its hour: seen at 4:17 PM peaks from 4 to 5 PM. The chance drops sharply per hour away from the peak, when the player is in that area:

    | Hours from the peak hour | Chance |
    |---|---|
    | 0 (peak) | ~50% |
    | 1 | ~20% |
    | 2 | ~5% |
    | 3 or more | ~2% |

    Quarter-hour granularity was considered and rejected as too complex.
  - **One roll per day.** Each NPC gets one roll (0-99) per game day, seeded deterministically from the NPC id, the place and the game day (from `clockAt`), and reused all day. Every check compares that same roll to the current hour's chance. So with a roll of 30, showing up an hour early (20%) misses her, while the same roll succeeds during the peak hour (50%). Swiping or regenerating can't flip a result.
  - **Looking for them by name** adds a second roll for the day, seeded separately (per NPC per game day, not per attempt), and the better (lower) of the two rolls is used from then on. Searching again the same day changes nothing.
  - **Stays for the hour.** Once she appears, the appearance is stamped on the message and she stays for the rest of that hour, so leaving and coming back doesn't make her vanish. Deleting the message undoes the appearance.
  - **No vanishing mid-scene.** An NPC in the current scene doesn't vanish when her hour ends; see *Leaving a scene*.
  - A one-off who gets a real schedule later (written by a creator or via Export to cast) stops using the sighting.

  ```json
  { "id": "maren", "name": "Maren", "line": "A traveling knife-grinder with a squeaky cart.",
    "seen_at": { "place": "riverton/market-square", "hour": 16, "chance": 0.5 } }
  ```

### Following

A simple **`following`** tag in phase 1: an NPC told to come along (stamp) is present wherever the actor they follow is (usually the player), overriding their schedule, until told to stay or wait. A **stay** stamp holds them at the place they are in when told, and does not send them back to the schedule. The hold lasts until the next schedule entry starts (or, for a one-off with no schedule, until that sighting hour ends), or until the player leaves and comes back to them, or until they are asked to follow again. Only then do they return to the schedule. The leaving-a-scene rule still applies, so when the hold ends while the player is with them they do not vanish; the narrator gets the overdue note instead.

**Invented details.** The model will make up small facts (a scar, a sister's name, a favorite drink). With the long history gone, these must be saved or they get contradicted later. After each reply, the same flag step the map uses (`ws_flag`) lets the narrator report new facts about present NPCs; the engine stamps them as `npc_fact` on the reply. A "Character changed here" bar (Edit / Turn off / Undo) shows them, like "Map changed here".

## Detail tiers in prompts

| Tier | Sent when | Contents |
|---|---|---|
| **Present** | NPC is in the scene but not the focus | Name, 1-2 sentence description, current activity (from schedule) |
| **Focused** | Player `[look]`s at or talks to them | Full visible appearance, manner, voice, disposition, relevant memory highlights |
| **Deep** | The conversation goes there (history, secrets, relationships, what they think of the player) | Deep fields, only the relevant ones |

The engine decides tiers **before generation**, as part of the per-message intent call we already make: one extra pick-one question ("who is the player addressing / looking at?", keys are NPC names, lenient matching, plus `nobody`) and a depth question (`present` / `focused` / `deep`). Start with simple rules: who the player named, touched or addressed.

**Backup:** the narrator gets a rare `need_detail` tool (npc id + what it needs). Each call is another round trip, so prompts tell it to use it only when it would otherwise invent something important.

## Context slicing (phase 1)

Slicing is the core of the vision, so it ships in phase 1 even while NPCs are only stubs. Phases 2-3 add layers to the same mechanism instead of rewiring it.

Per reply the engine works out:
- **Who's present:** NPCs whose current schedule entry resolves to the scene's place (plus any NPC tagged `following`). Only kept NPCs count; unsaved people are just part of the recent chat.
- **Who's in focus:** from the intent call.
- **Which memory notes go in:** only for focused NPCs, or present ones the reply concerns.

**Scene focus** reuses the existing idea: focus follows the player by default (the player's position), and can move to an NPC-only scene ("meanwhile, at the mill"), where the slice is built for that place instead.

The prompt gets the slices through new placeholders in `default.json` (e.g. `{{npcs_present}}`, `{{npc_focus}}`), documented the same way as the existing ones.

## Memory

- **Disposition** (replaces the old `met` flag; phase 1), see below.
- **Highlights:** short notes like "met the player at the inn; owes them a favor". Added by the flag step as `npc_memory` stamps, kept tight (a cap per NPC, oldest/least important summarized away later).
- Fed only when the NPC is focused, or when the reply clearly concerns them.

## Disposition (phase 1)

How the NPC feels about someone, using the classic D&D attitudes: `unknown`, `hostile`, `unfriendly`, `indifferent`, `friendly`, `helpful`.

- **A map keyed by the person,** e.g. `{"player": {"value": "friendly", "reason": "..."}}`. v1 only uses the `player` key, but companions and other NPCs can be added later without a migration.
- **Starts as `unknown`.** On first meeting, a pick-one call (text keys, lenient matching, one retry) assigns one, leaning heavily toward `indifferent`, which is also the fallback.
- **Creators can set a starting disposition** in the cast file (then no first-meeting call is needed).
- **Changes are stamps** (`npc_disposition`) with a short reason, at most one step per reply (e.g. indifferent to friendly) unless something dramatic happens (an attack, a rescue).
- **In the prompt:** the current disposition and its reason go in whenever the NPC is present (every tier).
- **Later:** persuasion checks hook into it once stats exist (future work).

```json
"disposition": { "player": { "value": "friendly", "reason": "The player paid off her tab." } }
```

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

**Export to cast:** an NPC who grew during play (the farmer who got a name, a tattoo and a history) exists only as stamps in that chat. "Export to cast" writes his current state (base record + all active stamps) into a clean record file in the world's `cast/`. This is the same idea as the existing "save chat as a new world" render, scoped to one NPC.

If that person **already came from a cast file with the same id**, the button is **Update &lt;name&gt;**. It shows a diff of the played record against the file, and on confirm writes that file in place. A person **created in play** never overwrites a file. A genuine clash with a different NPC (the id is already taken) writes `id-2`, `id-3`, and so on, and the old file stays.

## Schedule stub (phase 1)

A schedule is a list of entries: `{ place, activity, from?, to? }`. A stationary NPC has one entry with no times. This is where "where they show up and what they're doing" lives from day one, even before anyone moves.

**Place lookups go through the same redirects player positions use.** Map patches can merge, rename or move rooms; the engine already resolves stamped player locations through those redirects (`relocateMap`, `resolvePosition`). Schedule entries resolve the same way, so an NPC whose tavern got merged into the next room still shows up there.

**Failures, in order:**
1. Id resolves (directly or via redirect): use it.
2. Id points at an **expired** place (removed by a patch, e.g. the mill burned down): fall back to the NPC's **next valid entry**.
3. Id is **truly missing** (never existed in this world, e.g. a cast imported from another world): the entry is marked **broken**, never a crash. Broken entries show in the editor; an NPC with no valid entry is off-map until fixed.

### Leaving a scene

This applies to schedules in general and to one-off sightings.

- **The engine never removes an NPC who is in the current scene.** When their schedule (or their sighting hour) says they're due elsewhere, the narrator gets a one-line note instead, e.g. `Hesk is due at the forge (work)`.
- **The note escalates** the more overdue she is: `Hesk is due at the forge (work)` becomes `Hesk is an hour late for work`, so a narrator can't keep her lingering forever. Persuasion or a `staying` stamp has to keep up with it (staying more than a little while past her time takes fresh persuasion).
- **Importance.** Schedule entries take an optional `importance` field: `low` / `normal` / `high` (text keys, lenient matching). If it's left out, the model judges from the activity: "go to work" is insistent, "chill at home" is easygoing.
- **The narrator decides** whether the NPC lingers, mentions needing to go, or excuses herself. Leaving is a stamp (`npc_leave`) on that reply, so deleting or swiping it brings her back.
- **Staying.** The player can convince (or later force) her to stay: a `staying` stamp (staying with the player's group) overrides the schedule until she leaves or the scene ends. Once stats exist, persuading or forcing her can become a real check (see future work).

```json
{ "place": "riverton/forge", "activity": "work", "from": "08:00", "to": "17:00", "importance": "high" }
```

A later **cast import tool / schedule wizard** helps adapt broken entries to a new world.

### Map changes and schedules (phase 4)

When a map change (patch) touches a place, a small call checks the schedule entries pointing there and picks, per entry: `keep` / `change activity` / `move` (text keys, lenient matching). The results are **schedule stamps that depend on the causing map change**: turning that change off, undoing it, or letting it expire removes them automatically through the dependency check, like other dependent changes. Example: the Drowned Rat burns down, so Hesk's entry changes to "standing in the ruins" instead of "pouring drinks"; undo the fire and Hesk is back behind the bar.

Real movement over time comes in phase 4, using the game clock (`clockAt`) to pick the active entry and the snapshot cache (`snapcache.mjs`) to keep per-reply resolution cheap.

## Waiting until (to-do, likely alongside phase 1)

Waiting until an NPC shows up is the natural partner to sightings and schedules.

- **`[wait]` always requires a duration or an end time.** A wait with no time gets a note asking how long (nothing is stamped).
- **Optional end conditions can only end it early,** never extend it:
  - **a specific NPC shows up:** step hour by hour through the deterministic sighting/schedule rolls (the same seeded rolls as normal play, so the result matches what would have happened by walking in at that hour);
  - **a weather condition** (seeded, same hour-by-hour loop);
  - **a temporary change ends:** `lasts` expiries are known exactly, so jump straight to them.
- **Interruptions stop it early too,** such as an expiry or an arrival, as the wait already does today.
- The wait stamp records where it actually stopped and why, so deleting the message undoes it.

**Does `[wait] until 5pm` parse today?** Checked against master: the strict parser (`parseWait` in `plugin/ui/calendar.mjs`) only accepts the words dawn/morning/noon/dusk/evening/night/midnight or 24-hour `HH:MM`. `until 17:00` parses; `until 5pm`, `until 5 pm` and `until 5:00pm` are rejected with `time must look like "08:00"`. When the parser fails, `planWait` falls back to one small model call (`modelWait`, the `intent.wait_amount` prompt) that should turn "5pm" into `17:00`. So it works today, but only through an extra model call. Teaching the parser 12-hour times (`5pm`, `5:30 pm`) is a cheap fix to do with this work.

## Phases

0. **Per-actor positions** (prerequisite, its own PR, zero behavior change).
1. **Records and slicing (done):** NPC records (stub/full), placement, hesitant creation (suggested Keep card after ~3 replies, `[remember]` / `/ws-npc`, read-back from first appearance, no stand-ins), `following` tag, invented-detail stamps, disposition (map keyed by person, player only in v1) and memory highlights, context slicing (present/focus/memory), cast files, Export to cast, schedule stub with redirect-aware validation, one-off sightings with deterministic seeded rolls.
1.5. **Cast browser / editor in the map window (done):** search and filters, two-way place selection with people markers, a form editor with map-picked schedule places and inline validation, create / duplicate / delete, saves through the stateless `/cast/save` and `/cast/delete` routes, an "under the hood" inspector per person (schedule entry, sighting and by-name rolls, stub/full, following/staying, disposition, memory, scene declines, stamps with message links, Update with a diff), Who's here per place with no-show reasons, What the narrator was told and Not saved yet views recomputed from the chat, map highlighting of a person's places, and two edit modes with a diff on submit: Base (cast file) and In this chat (stamps on the latest message, checked against chat, message and swipe).
2. **Body and features:** body areas, features with short/long text, seen marks, simple coverage and coverage stamps, assembled descriptions.
3. **Wardrobe:** garment library, tags, outfits by tags, tag-informed reactions.
4. **Schedules and life off-screen:** NPCs move between places over game time, map changes re-check affected schedule entries (dependent stamps), NPC-only scenes as a common tool.

## Future work (not designed yet)

- **Hostile NPCs, and any NPC that needs stats once stats exist,** are an exception to hesitant creation. They'll likely need a record right away, even as passersby (a mugger in the street).
- **Persuasion checks against disposition** once stats exist.
- **Persuading or forcing an NPC to stay** becomes a real check once stats exist.
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
  "disposition": { "player": { "value": "indifferent", "reason": "Starting attitude: strangers are customers." } },
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
  { "type": "npc_fact", "id": "marta-ferris", "field": "deep.relationships.player", "text": "Thinks the player is trouble, but useful." },
  { "type": "npc_seen", "id": "marta-ferris", "feature": "tattoo" },
  { "type": "npc_coverage", "id": "marta-ferris", "uncover": ["arms"] },
  { "type": "npc_disposition", "id": "marta-ferris", "who": "player", "value": "friendly", "reason": "The player paid off her tab." },
  { "type": "npc_memory", "id": "marta-ferris", "note": "Gave the player a free room in exchange for a favor." }
] }
```

## Open questions

1. **Suggestion threshold:** is ~3 replies right, and what counts as "the same person" before they have a name (the engine matching "the barmaid" across replies)?
2. **Scene boundary for a remembered "no":** a location change, a time skip, or something the story engine decides later?
3. **Read-back range:** how far back can "since they first appeared" go in a long chat, and how is the first appearance found (asked of the model, or the earliest message mentioning them)?
4. **Memory cap:** how many highlights per NPC before older ones are summarized, and who summarizes?
5. **Depth decision:** a separate pick-one question, or folded into the existing intent call to save a round trip?
6. **Export conflicts (decided):** a person who already came from a cast file with the same id is **Update &lt;name&gt;**: a diff, then write that file in place on confirm. A person created in play never overwrites. A genuine clash with a different NPC (the id is taken) gets `id-2`, `id-3`, and so on. Play-created ids are name slugs.
7. **Following and stay (decided):** told to stay or wait, they hold the place they are in. They do not go back to the schedule until the next schedule entry starts, a one-off's sighting hour ends, the player leaves and comes back, or they are asked to follow again. The leaving-a-scene rule still applies when the hold ends. They do not drift (that is phase 4).
8. **Expired-place fallback:** if every entry is expired, is the NPC off-map, or placed at the nearest surviving neighbour like the player resolver does?
9. **Sighting area and curve:** what counts as "in that area" (the same room, or the same subregion?) when the chance applies at all? Are the hourly chances (~50/20/5/2%) fixed, or per-NPC/creator settings? And should the by-name roll also apply when the player isn't at the sighting place (e.g. asking around for her elsewhere)?
10. **Sighting place expired:** if a one-off's sighting place is merged or removed, follow redirects like schedules, and if it's truly gone, does the NPC become "by name only"?
11. **Phase 4 schedule check:** run the check when the map change is made (one call per change) or lazily the first time an affected NPC would appear?

### Activity log

The cast panel's **Activity log** view picks a message (latest by default) and lists what happened there: `ws_flag`s parsed, sighting and by-name rolls, stamps written (map, positions, people, wait/clock), cards and their outcome, and every model call's outcome. All of it is read from the message itself, so it survives a reload.

**Model-call notes.** Every model call the extension makes (the narrator reply and each side call: intent, discovery/dig, wait amount, Remember, pick-one prompts, map edits) leaves a small debug note in `msg.extra.worldscrawl_calls`, keyed by swipe: the call kind, `ok` / `failed` / `skipped` with the reason, the number of tries, a short answer, and for the narrator reply the `ws_flag`s and tags it emitted, or "narrator made no tool call". Side calls are noted on the message being handled (usually the latest). It is capped at 12 notes per swipe with text truncated, and is not a stamp: undo, rebuilds and snapshots never read it. Failed narrator generations themselves are not noted (no message is made). It is read-only. New flag types plug in with `registerActivity(extraKey, collect)` in `extension/activity.mjs` and, for custom display, `registerRenderer(kind, fn)` in `plugin/ui/activitylog.mjs`; unknown `worldscrawl_*` keys still show with a generic line.
