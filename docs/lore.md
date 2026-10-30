# Lore

Every place can have two kinds of text:

- **description**: what the senses show. It goes to the narrator on every move and look.
- **lore**: background knowledge, what locals know (history, who runs it, reputation). It is set at region, subregion or room level, in the `lore` key. The old `notes` key still loads, and `inherit_notes`, `inherit_region_notes` and `inherit_subregion_notes` work as `inherit_lore`, `inherit_region_lore` and `inherit_subregion_lore`, with the same stacking rules.

## How lore reaches the narrator

Lore is not sent by default. Each turn the narrator gets one index line naming the places with lore here, innermost first:

    Lore on file: The Drowned Rat, Riverton.

Lore is fed in only two ways:

1. **The narrator asks** with `[ws_flag: lore | The Drowned Rat]` at the end of a reply (or the ws_flag tool's `lore` action when map tools are on; the tool answers with the lore at once). The tag is removed from the reply. The lore stays fed while the player stays inside the place it is about: room lore in that room, building (subregion) lore anywhere in the building, region lore anywhere in the region. Once they leave it, it drops.
2. **The player forces it** with `[lore]` (all lore here) or `[lore] The Drowned Rat`. It is fed on that turn and from then on, by the same rule. `[lore]` is listed in `/ws-help`.

Fed lore is labelled as background knowledge, not what the senses show.

Each request is stamped on its message as `msg.extra.worldscrawl_lore`: `[{swipe, place, level, address, source: 'flag' | 'bracket'}]`. `loreRequests(chat)` (in `npc.mjs`) lists them all as `[{index, place, level, address, source}]`, and they show in the activity log.

## People in lore

Write cast NPCs as `{{npc:id}}`. In lore and descriptions it renders as the NPC's name before SillyTavern macros run. An unknown id shows as the bare id (or "someone") and logs a warning. Only tokens in lore being fed add presence lines ("Hesk is upstairs, asleep" / "Pell isn't here right now"); a place is never invented.

Loading a world warns when lore or a description names a cast NPC (or one of their aliases) in plain text ("did you mean {{npc:hesk}}?"), and when a token's id matches no cast NPC.

## Later

Keyword serving (feeding lore when the story mentions a place's name or a keyword) is not done. It may come later; for now lore is only fed when asked for.
