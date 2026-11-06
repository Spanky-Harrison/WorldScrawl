# Engine and behaviour principles

How WorldScrawl is supposed to work. Process rules are in [CONTRIBUTING.md](CONTRIBUTING.md); UI and code style are in [STYLE.md](STYLE.md).

## Two engines
- The **world engine** models physical reality: places, exits, doors, time, weather, and where NPCs are. The **story engine** comes later. Don't put story logic into the world engine.
- Complexity goes in the engine. The world JSON stays simple for the people writing it.

## Who changes state
- Narrative state changes (new NPCs, discoveries, map or character updates) come only from the **player** (brackets, `/ws-` commands, and a tag pasted into the text) or the **after-reply tracker** (a separate question that reads the latest exchange). The narrator does not report them. They never come from engine text matching.
- Keyword matching is fine for serving read-only context such as lore.
- Brackets hold only the verb, inside normal prose ("I [look] out the window"). The verb is certain; the target is found from the words after it, matched locally first, with a small model call for the target only if needed.

## The player is omnipotent
- Restrict player input only when it's invalid or would break something.
- Guards and plausibility checks (near/within, one-step limits, duplicate-room checks and so on) apply to the model only. A player action that bypasses a guard goes through, and the inspector notes it as a player override.
- Facts the NPC knows (has met the PC, knows the PC's name, and similar facts added later) move backwards only by a player edit. Things that rise and fall naturally, like attitude, stay with the model under the usual one-step limit.

## Visibility
- Everything the engine feeds the model or decides shows in the inspector: what was decided, why, and what the model was told. Don't ship engine behaviour Knarfy can't see.

## State
- The engine is stateless. State lives in stamps on chat messages, and every cache can be rebuilt from the chat.
- The server keeps no chat state. The browser sends `changes` and `now` with each call that needs them.

## Code placement
- The extension is dead without the server, so depending on the server is never a cost.
- Extension-only code lives in `extension/`, server-only code in `plugin/`, and code that both sides run in `plugin/shared/` (pure: no DOM, Node or fetch), served to the browser at `/shared/*`. No copies of the same code on both sides.

## Changes and patterns
- Map changes follow one pattern: stamps, `lasts` (temporary vs lasting), notices with Edit/Undo, the flag-and-retry flow, and dependencies. NPC changes follow the same pattern.
- Linked exit pairs are treated as one thing. Hand-written labels are never auto-renamed.
- Every map change pulls in its neighbours one step out.

## Model calls
- Pick-one model calls return text labels, never numbers. They share one base prompt and a lenient reader.
- Context comes in tiers: present, then engaged, then topical. Place lore is fed only when it's topical; sensory descriptions come on moves and looks.
- NPCs in lore are written as `{{tokens}}`, resolved to what the PC knows.

## Token budget
- Keep prompt text lean and send detail only when it's needed.
- Nothing that is shown only on screen is sent to the model.
- Prompt snapshot growth must be justified ([CONTRIBUTING §PRs](CONTRIBUTING.md#prs)).
- For the docs and code: keep files small, read CODEMAP first, read only the files you need, and don't re-read big files.
