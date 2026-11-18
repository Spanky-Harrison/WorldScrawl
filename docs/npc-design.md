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
- **UI reuses existing patterns:** the Approve / Adjust / Discard card (as in room discovery) and the Edit / Turn off / Undo bar (as in "Map changed here").
- **Actor placeholders** are our own: `{{party}}`, rendered from the player's group (see *Actors, not a party*), not SillyTavern's `{{user}}`/`{{char}}`.

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
| **Stub** | Name and one line (or more, see below). A real record. | Hesitant creation, see below. Approve stamps an `npc_create` on that message. |
| **Full** | Detailed description, features, memory, schedule. | Grows through stamps as play adds detail. Creators can also author full NPCs directly. |

### Hesitant creation

- **Passersby stay scenery:** no record, no card. Asking the barmaid for a drink does not create an NPC.
- **Suggestion:** after about **3 replies involving the same person**, the engine suggests a **Approve / Adjust / Discard** card.
- **Explicit:** the player can ask at any time with `[remember]` in a message (e.g. "I'm going to [remember] Maren") or `/ws-npc`.
- **A "no" is remembered for the current scene** (stamped on the message, so it's undoable), and the card isn't offered again for that person until the scene changes.
- **Keeping reads back, not a blank stub.** Keeping pulls the name, appearance and stated facts from **every message since the person first appeared**, like the flag step reading a range of messages. The record starts with what the story already said.
- **No stand-ins.** A saved NPC appears only via their schedule (including a might-be-at roll), by following the player, or when the player finds them where their schedule puts them. They are never reused as a random stranger ("a guard" is never secretly the guard you saved last week).
  - **Future story-engine hook:** a story engine (never the default engine) may *deliberately* place a saved NPC as an anonymous figure ("a guard") and reveal them later, as a twist. By default, saved NPCs are never reused as strangers by accident.
- **One-offs get a passing-through schedule (might be at).** The one-off "seen at" sighting (`seen_at`, the hourly curve and the by-name roll) is gone. A schedule has two kinds of entry: **is at** (certain; every older entry is one, unchanged) and **might be at**, a time block with options and percent odds:

  ```json
  { "might": ["riverton:streets/market_lane", "riverton:general_store/shop", "nowhere(80)"], "activity": "running errands", "from": "10:00", "to": "12:00", "wandering": false }
  ```

  - **Options.** A room; an area (a subregion or region: it picks one of its public rooms, never a private one); a stub place or plain words (off the map); or `nowhere`. A `(N)` is a percent; options without one split what is left of 100; a total under 100 leaves the rest as nowhere; over 100 breaks the entry. An option not on the map yet is kept and its share is away until the room exists in this chat's map.
  - **Rolls.** A normal block rolls once when it starts and holds for the whole block; `wandering: true` moves them every 15 to 60 minutes, each stretch rolling its own place. Every roll is seeded from the person, the entry and the actual start time, so swipes and reloads never change it. There is no by-name roll; see *Finding someone* below for `[find]`.
  - **Chances add up.** Adjacent blocks each roll on their own: three hourly rows at 20%, 50% and 20% give roughly a 70% chance of meeting them at some point in those three hours (1 − 0.8 × 0.5 × 0.8 = 68%). To make someone likely across a span, write one block with the odds you want.
  - **Remember writes one: a daily pattern.** A person kept with Remember gets a schedule from a pattern the engine expands (`expandPattern` in `plugin/shared/npc.mjs`). Engine-made schedules never overlap. "Spots" are the favorites, or with none the area (subregion) of the job room, else of the room they were met in; "30% in all" over several spots is written on each (`a(10), b(10), c(10)`, the rounding remainder to the first), the rest nowhere. **Met-place guard:** when the meeting time falls inside a free-time block (lunch, evening, break or afternoon) and the spots do not already cover the met room (the room itself or an area holding it), the met room joins that block's spots (the total split over all of them), so they can still be found where they were met; this applies to the model's pick, typed edits and Check schedule again alike, and not to passing through. **Area jobs.** A job may be an area (`pick.job_area`, derived on every read): its two work blocks are written as `might: ["<area>(100)"]`, wandering, importance high, instead of is-at entries; a one-room area is not converted. A room and the area holding it that share a name read as the area. An area with no public room is an error for the model's pick and a warning on a typed edit (strict reads), where Anywhere can be set later in the editor. Free-time blocks are "out and about"; the job is `job_activity` or "working" (importance high); home is "at home" (a room on the map, or off the map: `where: "home"` plus `near` for a named off-map home).

    | Pattern | Is at | Might be at |
    |---|---|---|
    | **Day shift** | job 08:00–12:00, 13:00–17:00; home 17:00–18:30, 20:00–08:00 | lunch 12:00–13:00, spots 30%, normal; evening 18:30–20:00, spots 40%, wandering |
    | **Night shift** | job 18:00–22:00, 23:00–03:00; home 03:00–14:30, 16:00–18:00 | break 22:00–23:00, spots 30%, normal; afternoon 14:30–16:00, spots 40%, wandering |
    | **Passing through** (also unsure, and the fallback) | home 20:00–07:00 clipped around the block; open "about their own business" | the met room 50%, one normal block from an hour before the met hour (rounded down) to an hour after |

    **The pattern question.** When the Remember card's answer arrives, one JSON question (`npc.schedule_pick_system` / `npc.schedule_pick`, locked, group `npc`; masked by the name portal) gets the shown name, the card's line and looks, the met room and time (also said again before the reply line: they were met here then), the Remember read-back excerpt, and up to 40 rooms of this chat's live map, nearest first (`KEY: name (area) [private]`), the areas holding them, and the stub places off the map. It answers `{pattern, job, job_activity, home, favorites}`: a job is a listed room, area or stub KEY, a home a listed room or stub KEY, either may be `offmap: short text` (at most 80 characters) or null; favorites are up to 3 public room or area KEYs. An area is listed only when it has a public room among the listed rooms. The game checks it (`readSchedulePick`): an unknown job, or an area job with no public room, is an error, asked once more with the error (`npc.schedule_pick_retry`), then passing through; an unknown home or an area as home becomes null (off the map) with a warning; unknown or private favorites and any past three are dropped; a shift with no job is passing through; unsure is passing through. It runs once per card, cached on the card per swipe, shown on the card while it runs; every outcome is noted in the call log as kind `schedule`. Approve waits for a question in flight and never asks a second time; Approve with none asked yet asks it then. **Check schedule again** asks only this question again. **Edit** adds Pattern / Job / Home / Favorites boxes; Approve edited reads them strictly against the whole live map (a name two places share, an area as a home, an unknown or private favorite, or a shift with no job is an error shown on the card) and expands with no model call. The `npc_schedule` stamp keeps the pick, the met room and minute, and a one-line summary; its kept note has Edit (the same boxes, expanded again at the met room and time) and Undo. A `stay` stamp holds them in the scene where they were met. A creator can rewrite the schedule in the Cast editor (Is at / Might be at per row) or via Export to cast.
  - **Private rooms.** `"private": true` on a room (or inherited from its subregion, region or world) keeps area picks out of it; a schedule that names the room still uses it. An area with no public room is away, with an inspector note. A block with `"anywhere": true` (next to `wandering`; set only in the editors, never by the pattern question) lets its area options include private rooms too: the roll, `[find]` and Who's here all read the same resolver, so `[find]` from a private room of the area works for that block. Editing the flag re-rolls the block; blocks without it keep their seeds. A block with `anywhere` and no area option loads with a note.
  - **No vanishing mid-scene.** Someone in the current scene stays until the block ends; see *Leaving a scene*.
  - **Finding someone (`[find] Name`, `/ws-find Name`).** No roll. Already in the player's room (the place Who's here and the cast panel show): nothing changes, and the player gets a "right here" notice. If the current might block put them somewhere on the map (a wandering block: this stretch) and the player's room is one of the block's options, resolved by the same code as the roll (a room named outright, private or not; a public room of a named area; this chat's live map), a whole-block appearance stamp (`npc_appear` with `whole: true`) moves them to the player's room until the block ends, through every wandering stretch, and the narrator gets `narration.npc_found` ("X has just come in."). Nowhere or off the map this block, a room that is not one of the options, an is-at entry anywhere else (an off-map one too), following someone else, told to stay elsewhere, or no schedule: they can't be found, with the reason on the message; the narrator gets `narration.npc_not_found` right after the player's message ("X looks for Y but does not find them. Y is not here and does not appear in this reply in any form…") and, when the player knows the name, `narration.npc_identity` ("Hesk is the landlady of the Drowned Rat."), no reason. Right here is a command (no reply, the message hidden); a name that matches nobody saved is a failed command. Another `[find]` later in the same block from another valid room moves them again.

### Following

A simple **`following`** tag in phase 1: an NPC told to come along (stamp) is present wherever the actor they follow is (usually the player), overriding their schedule, until told to stay or wait. A **stay** stamp holds them at the place they are in when told, and does not send them back to the schedule. The hold lasts until the next schedule entry starts (a might-be-at block counts as an entry), or until the player leaves and comes back to them, or until they are asked to follow again. Only then do they return to the schedule. The leaving-a-scene rule still applies, so when the hold ends while the player is with them they do not vanish; the narrator gets the overdue note instead.

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

This applies to every schedule entry, is at and might be at.

- **The engine never removes an NPC who is in the current scene.** When their schedule (or the end of a might-be-at block) says they're due elsewhere, the narrator gets a one-line note instead, e.g. `Hesk is due at the forge (work)`.
- **The note escalates** the more overdue she is: `Hesk is due at the forge (work)` becomes `Hesk is an hour late for work`, so a narrator can't keep her lingering forever. Persuasion or a `staying` stamp has to keep up with it (staying more than a little while past her time takes fresh persuasion).
- **Importance.** Schedule entries take an optional `importance` field: `low` / `normal` / `high` (text keys, lenient matching). If it's left out, the model judges from the activity: "go to work" is insistent, "chill at home" is easygoing.
- **The narrator decides** whether the NPC lingers, mentions needing to go, or excuses herself. Leaving is a stamp (`npc_leave`) on that reply, so deleting or swiping it brings her back.
- **Staying.** The player can convince (or later force) her to stay: a `staying` stamp (staying with the player's group) overrides the schedule until she leaves or the scene ends. Once stats exist, persuading or forcing her can become a real check (see future work).

```json
{ "place": "riverton/forge", "activity": "work", "from": "08:00", "to": "17:00", "importance": "high" }
```

### Placeless entries, stub regions, and finding someone

A schedule entry may omit `place`. It then needs `activity`, and may have:

- `where`: a short label, such as "her own room" or "at home".
- `near`: where that is, in this order: a real map address (`riverton:drowned_rat`, a room, or a region id); an id from the world's stub list; or plain text ("a fishing camp up the river"), passed to the narrator as written.
- `from`, `to`, and `importance`, as on a placed entry.

While that entry is in force the person is off the map: never present in any scene. The narrator gets an absent line built from it, for example `Hesk: asleep, elsewhere (her own room, in The Drowned Rat)`. A single word in `near` that matches neither a map address nor a stub id is a load warning (probably a typo). Multi-word text is not a warning; the inspector only notes that it is not in the list.

**Stub regions** are places that exist in the fiction but not on the map. `worlds/<world>/elsewhere.json`:

```json
{ "wickerton": { "name": "Wickerton", "about": "a farming town three hours' ride north of Riverton", "lore": "optional" } }
```

The narrator gets `about` when it is relevant (an absent line, a rejected find). Optional `lore` is served exactly like place lore: only when the player writes `[lore] Wickerton` (or a `[ws_flag: lore | Wickerton]` tag is pasted into a reply); the narrator is not told to write tags. If a real region with the same id is later built, references resolve onto the map and nothing is rewritten. Travel time between a stub and the map is out of scope (the future off-screen-life phase).

**Found by the story.** The after-reply tracker's found proposal (and a `[ws_flag: found | Name]` tag) put that person in the current room for their current placeless entry. The player's `[find]` does not: for it, off the map counts as nowhere (see *Finding someone* above). It is accepted only when `near` is a map address and the current room is within it. A stub or plain-text `near` is rejected, with the reason shown on the message. The stamp is keyed to the entry's `where` label, not to one entry: every entry of that person with the same `where` then resolves to that room in this chat. The message shows a notice with Edit and Undo, the same shape as a discovered room. In the Cast editor, **Make this permanent** writes that room into the base schedule as a normal placed entry. Deleting the message undoes the find.

The narrator is told (in `narration.offmap_found`, added under the people list whenever it names someone off the map) that anyone listed as elsewhere is not with the characters unless they have actually come here; when the story brings such a person in, the after-reply tracker proposes the find. This is the models' judgment only; the engine never scans the text for names. A room discovered during play inside the near place counts as within it (addresses under the near subregion).

A later **cast import tool / schedule wizard** helps adapt broken entries to a new world.

### Map changes and schedules (phase 4)

When a map change (patch) touches a place, a small call checks the schedule entries pointing there and picks, per entry: `keep` / `change activity` / `move` (text keys, lenient matching). The results are **schedule stamps that depend on the causing map change**: turning that change off, undoing it, or letting it expire removes them automatically through the dependency check, like other dependent changes. Example: the Drowned Rat burns down, so Hesk's entry changes to "standing in the ruins" instead of "pouring drinks"; undo the fire and Hesk is back behind the bar.

Real movement over time comes in phase 4, using the game clock (`clockAt`) to pick the active entry and the snapshot cache (`snapcache.mjs`) to keep per-reply resolution cheap.

## Waiting until (to-do, likely alongside phase 1)

Waiting until an NPC shows up is the natural partner to might-be-at blocks and schedules.

- **`[wait]` always requires a duration or an end time.** A wait with no time gets a note asking how long (nothing is stamped).
- **Optional end conditions can only end it early,** never extend it:
  - **a specific NPC shows up:** step hour by hour through the deterministic might-be-at/schedule rolls (the same seeded rolls as normal play, so the result matches what would have happened by walking in at that hour);
  - **a weather condition** (seeded, same hour-by-hour loop);
  - **a temporary change ends:** `lasts` expiries are known exactly, so jump straight to them.
- **Interruptions stop it early too,** such as an expiry or an arrival, as the wait already does today.
- The wait stamp records where it actually stopped and why, so deleting the message undoes it.

**Does `[wait] until 5pm` parse today?** Checked against master: the strict parser (`parseWait` in `plugin/ui/calendar.mjs`) only accepts the words dawn/morning/noon/dusk/evening/night/midnight or 24-hour `HH:MM`. `until 17:00` parses; `until 5pm`, `until 5 pm` and `until 5:00pm` are rejected with `time must look like "08:00"`. When the parser fails, `planWait` falls back to one small model call (`modelWait`, the `intent.wait_amount` prompt) that should turn "5pm" into `17:00`. So it works today, but only through an extra model call. Teaching the parser 12-hour times (`5pm`, `5:30 pm`) is a cheap fix to do with this work.

## Phases

0. **Per-actor positions** (prerequisite, its own PR, zero behavior change).
1. **Records and slicing (done):** NPC records (stub/full), placement, hesitant creation (suggested Approve card after ~3 replies, `[remember]` / `/ws-npc`, read-back from first appearance, no stand-ins), `following` tag, invented-detail stamps, disposition (map keyed by person, player only in v1) and memory highlights, context slicing (present/focus/memory), cast files, Export to cast, schedule stub with redirect-aware validation, one-off sightings with deterministic seeded rolls.
1.5. **Cast browser / editor in the map window (done):** search and filters, two-way place selection with people markers, Who's here, What the narrator was told, Not saved yet, and map highlighting. The open person uses the same tabs as a place: Resolved (the effective card, each row sourced, with the live schedule), Raw, State (where and why, plus this chat), Warnings and Changes (stamps, linked to their messages). One Edit button, disabled with no chat, stamps the latest message. Update, Save as new and New person write a cast file from an authoring form seeded with the base plus lasting chat changes, not a temporary transformation. Delete removes the file only. Make this permanent still writes a found room into the base schedule.
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
{ "id": "old-tom", "name": "Old Tom", "personality": { "summary": "A stooped farmer who never stops complaining about the river." }, "schedule": [{ "place": "riverton/south-field", "activity": "hoeing turnips" }] }
```

A full NPC:

```json
{
  "id": "marta-ferris",
  "name": "Marta Ferris",
  "unknownAs": "the landlady",
  "personality": { "summary": "The Drowned Rat's sharp-eyed landlady", "manner": "Brisk, dry humor, softens around children.", "speech": "Low, clipped; calls everyone 'love'." },
  "appearance": { "summary": "a forty-odd woman, sleeves always rolled", "body": "Forty-odd, wiry.", "outfit": "Sleeves always rolled." },
  "history": "Ran with river smugglers in her twenties.",
  "disposition": { "player": { "value": "indifferent", "reason": "Starting attitude: strangers are customers." } },
  "deep": {
    "secrets": ["Still fences goods for the Kettle crew."],
    "relationships": { "old-tom": "Owes him money; avoids him." }
  },
  "body (later phase, not read yet)": {
    "features": [
      { "id": "tattoo", "area": "chest", "short": "a rose tattoo reading CAPTAIN",
        "long": "Three roses wound around a ship's wheel, CAPTAIN inked in faded navy capitals across the middle." },
      { "id": "scar", "area": "hands", "short": "a pale scar across her left knuckles" }
    ],
    "covered": ["chest", "back", "arms"]
  },
  "schedule": [
    { "place": "riverton/drowned-rat/taproom", "activity": "pouring drinks", "from": "16:00", "to": "02:00" },
    { "activity": "asleep", "where": "her own room", "near": "riverton:drowned_rat" }
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
7. **Following and stay (answered):** told to stay or wait, they hold the place they are in. They do not go back to the schedule until the next schedule entry starts (a might-be-at block counts), the player leaves and comes back, or they are asked to follow again. The leaving-a-scene rule still applies when the hold ends. They do not drift (that is phase 4).
8. **Expired-place fallback:** if every entry is expired, is the NPC off-map, or placed at the nearest surviving neighbour like the player resolver does?
9. **Sighting area and curve (answered: no sighting):** replaced by might-be-at blocks; an area option picks one public room, the odds are written per block, and there is no by-name roll. Was: what counts as "in that area" (the same room, or the same subregion?) when the chance applies at all? Are the hourly chances (~50/20/5/2%) fixed, or per-NPC/creator settings? And should the by-name roll also apply when the player isn't at the sighting place (e.g. asking around for her elsewhere)?
10. **Sighting place expired (answered: no sighting):** might options resolve like any schedule place (redirects, then the live map); an option not on the map yet is away until it exists. Was: if a one-off's sighting place is merged or removed, follow redirects like schedules, and if it's truly gone, does the NPC become "by name only"?
11. **Phase 4 schedule check:** run the check when the map change is made (one call per change) or lazily the first time an affected NPC would appear?

### Activity log

**Debug > Activity log** (top bar of the map window) opens its own full view, like the tools, so it never shares the side pane with Cast or the Editor (clicking Cast, Editor or Close leaves it). It picks a message (latest by default) and lists what happened there: `ws_flag`s parsed, `[find]` results, stamps written (map, positions, people, wait/clock), cards and their outcome, and every model call's outcome. All of it is read from the message itself, so it survives a reload.

**Model-call notes.** Every model call the extension makes (the narrator reply and each side call: intent, discovery/dig, wait amount, Remember, pick-one prompts, map edits) leaves a small debug note in `msg.extra.worldscrawl_calls`, keyed by swipe: the call kind, `ok` / `failed` / `skipped` with the reason, the number of tries, a short answer, and for the narrator reply the `ws_flag`s and tags it emitted, or "narrator made no tool call". Side calls are noted on the message being handled (usually the latest). It is capped at 12 notes per swipe with text truncated, and is not a stamp: undo, rebuilds and snapshots never read it. Failed narrator generations themselves are not noted (no message is made). It is read-only. New flag types plug in with `registerActivity(extraKey, collect)` in `extension/activity.mjs` and, for custom display, `registerRenderer(kind, fn)` in `plugin/ui/activitylog.mjs`; unknown `worldscrawl_*` keys still show with a generic line.

## The card: personality, appearance, history, unknownAs

A cast file carries:

```json
{
  "id": "hesk", "name": "Hesk", "unknownAs": "the landlady",
  "personality": { "summary": "stern, watchful, sharp-tongued", "manner": "how they behave", "speech": "how they talk" },
  "appearance": { "summary": "a short first impression", "body": "physical only: build, age, face, hair, marks", "outfit": "what they usually wear and carry" },
  "history": "their life before the game starts",
  "disposition": {}, "schedule": [], "facts": [], "memory": [], "deep": { "secrets": [], "relationships": {} }
}
```

- `personality.summary` is required. The rest is optional.
- `outfit` is kept apart from `body` because it becomes inventory later.
- `unknownAs` is what the player calls them before learning the name. Leave it empty and the name is used from the start.
- Active memory stays per chat, as stamps. A chat edit is an `npc_fact` stamp whose field is `personality.summary|manner|speech`, `appearance.summary|body|outfit`, `history` or `unknownAs`. Remembered NPCs carry all of these in `npc_create`.
- Ideal, bond and flaw are deferred. They are not on the card yet.
- The loader still reads a top-level `line`, `manner`, `voice` or a string `appearance`. Shipped worlds use only the new shape.

### Feeding tiers

1. **Present** (everyone the narrator is told is here): name (or `unknownAs`), `appearance.summary`, `personality.summary` and the current activity.
2. **Engaged**: adds body, outfit, manner, speech, disposition and the last few memory highlights. A person is engaged when
   - the player looks at them ("I look at Hesk", `[look] Hesk`), or
   - they are the focus, or
   - they are following the player, or
   - the after-reply tracker flagged them in the last 3 replies.
3. **Topical**: adds `history`. This happens only when a lore request in the current scene names them (the player's `[lore] Hesk`, or a pasted `[ws_flag: lore | Hesk]` tag).

The focus slice still adds facts, the full memory and, at deep focus, secrets and relationships.

The inspector's "What the narrator was told" table shows, for each person: the tier and its reason, whether history was added, and the name state.

### Name knowledge

All of this goes through the name portal (`extension/names.mjs`). Names are known per actor, never per party, and known-ness is read from the folded stamps at a message, so turning off or undoing a name stamp hides the name again at once. A name counts as known only when:

- a remember stamp (`npc_create` marks the rememberer: "known: remembered");
- an `npc_name` stamp; or
- the player's `/ws-know Name | named` edit.

A card with no `unknownAs` counts as known. `aliases` (other names: nicknames, short forms) are treated like the name.

`learnName` (scene.mjs) is the only writer of `npc_name`. A learn from the model (the tracker's `name` item, and a pasted `[ws_flag: name | Name]` tag) must pass the portal's rules: the person resolves (the tracker's item by its own id or handle; its name is only what was heard), is in the scene, does not already know the name, the heard name is their name or an alias, and it was spoken: inside double quotes in the reply, or anywhere in the player's own line. A refused learn is noted in the model-call log. The player's line also learns a name with no model call (`learnSaidNames`, source `player line`, before the tracker): when it uses an unknown person's name or alias, here or not, that an earlier story reply wrote with the same capitalization (in dialogue or not); off with People changes. A tracker name item for the same person is then skipped ("already knows"). The player's `[name]` and `/ws-name` always land; a rule they skipped is kept on the stamp as `override` and shown in the inspector ("player override: ...").

While the name is unknown, every engine block the narrator gets says `the landlady` instead of the name or an alias (the facts block is masked as a whole in applyFacts, the prompt choke point), and people are listed with an opaque per-chat handle (`the landlady [p7k2]`), never the cast id. The one exception is a gated line, only while she is in the scene: "If the landlady is introduced or called by name in spoken dialogue, their name is Hesk." (`narration.name_gate`). The narrator ends its reply with `[ws_flag: name | Hesk]` once the name is said; the learn rules above still apply. The side calls get the same view: the tracker's people and expiry lines (shown name and handle; the tracker's line adds "(name not yet known)", and it answers with the handle as the id), the first-meeting disposition and focus pick-one (handles as the keys), the appearance rebuild and looks summary. Only the engine-built parts are masked, never the story or the player's line. Past chat text is not masked; the guarantee covers engine-injected blocks only. After masking, applyFacts checks the block once more (the gated lines aside); a name still there is logged as a `name leak` in the model-call log and the console, and the turn goes on.

### Remember

Remember asks the model to fill every field:

- first, what the story established;
- then plausible gaps, including history if the story implies one, `unknownAs` when it makes sense, and disposition.

Every made-up detail is listed in `invented`. That list is shown in the "Character changed here" bar, and in the cast editor's In-this-chat view and diff. It is never written to the cast file.

The cast editor has all of these fields in both Base and In-this-chat modes, and they are included in the diff.

**Prefetch.** The remember call starts as soon as a Remember card appears (once per card id), and is logged as `remember (prefetch)` in the model-call notes. The answer is cached on the card in `msg.extra.worldscrawl_remember.proposal`, per swipe, so a redraw never calls again. While the call runs, the card shows "Preparing…". Once the answer arrives, the card shows the proposed person: the name and `unknownAs`, `personality.summary` and `appearance.summary`, with the rest under Details and invented items marked ⚠. If the call fails, the card shows a Retry button. Approve saves the cached proposal instantly. If Approve is clicked before the answer arrives, the card shows "Saving…" and waits for the call already in flight; it never starts a second one. Adjust with a typed line skips the model. Adjust with a new name asks again for that name.
