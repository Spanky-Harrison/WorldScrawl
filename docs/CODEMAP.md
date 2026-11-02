# Code map

Where things live. Every PR that moves or adds a file updates this page (see CONTRIBUTING.md).

## extension/ (SillyTavern UI extension; runs in the browser)

The manifest loads `index.js`. Everything else is an ES module that index.js imports. index.js re-exports what it used to export, so tests and e2e can keep importing from `index.js`.

| File | Owns | Entry points |
|---|---|---|
| index.js | Startup (`init`), on/off and settings access, world sync and the chat-to-world link, rebuilding from the chat, look/move actions and their pending state, expiry state, the prompt interceptor (`globalThis` hook), save-world, the map channel, the change-editor tab. It keeps every mutable state variable that `init` or more than one topic writes | `init` IIFE, `isOn`, `settings`, `syncWorld`, `saveWorld`, `rebuildFromChat`, `lookAction`, `moveAction`, `PLUGIN_URL`, `MAP_URL` |
| clock.mjs | Calendar, game clock, weather now, world/chat names, chat changes | `clockAt`, `gameDate`, `effectiveWorld`, `chatChanges` |
| doors.mjs | Door and bar state: open/closed, barred, sight and sound through doors | `doorStates`, `isOpenNow`, `isBarredNow`, `viewOf` |
| expiry.mjs | Narration when something expires (options, pick prompt, notice) | `expiryPickPrompt`, `expiredNotice`, `ensureStartStamp` |
| movement.mjs | Choosing a destination from model answers, step-taking, reveals | `parseChoice`, `pickKey`, `stepsTaken`, `applyReveals` |
| dig.mjs | Digging up new places (prompt, answer reading, duplicate merge) | `digPrompt`, `readDigAnswer`, `mergeDuplicates` |
| looking.mjs | Look targets, door look, windows | `lookOptions`, `lookTargetPrompt`, `closedDoorPrompt` |
| brackets.mjs | Player brackets (`[look]`, `[move]`…) and help text | `parseBracket`, `bracketIntent`, `helpText` |
| scene.mjs | Scene/NPC tokens fed to the narrator, lore, the found notice and its Edit (`applyFound`, `judgeFoundNow`), live places from `POST /cast/places` | `renderTokens`, `applyFound`, `refreshLivePlaces` |
| footer.mjs | Exits text and the footer shown under replies | `exitsText`, `namedNpcsAt` |
| mapwindow.mjs | Opening the map window, theme vars, map state | `openMapWindow`, `mapState` |
| patches.mjs | Map patches (lasting changes) and the `FLAG_TAG` / `ws_flag` wait hint | `previewOps`, `toggleChange`, `FLAG_TAG` |
| carriers.mjs | Carrier messages for changes, patch library, edit calls, flag cards | `snapCarriers`, `restoreCarriers`, `flagCardView` |
| discovery.mjs | Discovery prompts, `ws_flag` handling on replies, tool registration | `onReplyForFlags`, `flagMessage`, `registerTools` |
| waits.mjs | Waits: model and player waits, Keep/Discard, patch cards | `planWait`, `proposeWait`, `renderPatchCards` |
| settings.mjs | The settings panel | `addSettingsPanel` |
| npc.mjs | Copy of plugin/npc.mjs (a test checks they match). NPC records, flags, `judgeFound` / `foundEditOk` | see plugin/npc.mjs |
| actors.mjs | Per-actor positions and the party (browser only; the server never needs them) | `positionOf`, `playerAddress`, `positionsAt` |
| prompts.mjs | Copy of plugin/ui/prompts.mjs | — |
| words.mjs | Pure word checks and tag parsing (`LOOK_RE`, `MOVE_RE`, `WAIT_TAG`) | — |
| notices.mjs | Shared in-chat notice layout and decisions | `addNotice` (via brackets), `markDecided` |
| activity.mjs, calllog.mjs, timelabels.mjs | Activity log, model-call notes, game-time labels | — |
| manifest.json | SillyTavern extension manifest (entry `index.js`) | — |

## plugin/ (SillyTavern server plugin; Node)

| File | Owns |
|---|---|
| index.mjs | Plugin entry; mounts the API at `/api/plugins/worldscrawl/` |
| server.mjs | Framework-free API handler, routes incl. `POST /cast/places` |
| world.mjs, position.mjs, changes.mjs, snapcache.mjs | World loading/validation, position resolver, per-chat changes, map snapshot cache |
| npc.mjs, cast.mjs | NPC records and stamps (`judgeFound`, `foundEditOk`), cast files |
| prompts.mjs, prompts/default.json | Prompt profiles per user; the default prompt text for every model call |
| inspect.mjs, editctx.mjs, movenotes.mjs, weather-config.mjs, ui.mjs | Inspector data, edit-form context, move inheritance notes, weather config, static UI serving |
| climates/*.json, exit_types.json, sky_types.json, wind_levels.json | Data tables |
| config.example.json, package.json | Config template, package metadata |
| ui/ | The map window: `app.js` (entry), `index.html`, `app.css`, and modules: activitylog, calendar, castdata, castpanel, changeedit, diffview, doorbar, mapactions, mapdata, menus, patches, patchform, picker, placeform, prompteditor, prompts, weather |

## tests/

| Path | What |
|---|---|
| node/*.test.mjs | Unit tests, one file per topic (27 files; run `node --test tests/node/*.test.mjs`): actors, barred, calllog, cast, dig, discover, exits, expiry, flags, inspect, mapactions, modeledits, notices, npc (incl. NPC card, live schedule/places, lore), patches (incl. patch form, toggles, diff view, move diff, change editor), placeform, placeless, position, prompts, snapcache, time, ui (incl. menus, picker), wait, weather, words (incl. brackets, carriers), world (incl. slugs, bases), worlds. Merged files keep each original file's tests in its own `{ }` block under a `// ---- from <old file>` comment. Helpers: `helpers.mjs` (incl. `extSource()`), `ststub.mjs` (SillyTavern stub), `useprompts.mjs`, `fixtures/` |
| e2e/run.sh, e2e/fake-openai.mjs | Starts a throwaway SillyTavern with the plugin and a fake model, then runs `E2E_SCRIPT` (default `e2e.mjs`) |
| e2e/e2e.mjs | Run-all: joins `e2e/parts/*.part` in order into `e2e/.assembled.mjs` (git-ignored) and runs it |
| e2e/parts/NN-topic.part | The e2e checks by topic, as chapters of one browser session that share variables (not standalone modules): 00-setup, 01-tools, 02-movement, 03-names-routing, 04-requests-reveals, 05-dig-look, 06-doors-exits, 07-map-window-edits, 08-wizards-toggles, 09-discovery, 10-menus-prompts, 11-cast, 99-teardown |
| e2e/snapshot.mjs, e2e/prompts.golden.json | Prompt snapshot: every model request in a scripted chat vs. the golden file |
| bench/snapcache.bench.mjs | Snapshot cache benchmark |

## API (plugin routes at `/api/plugins/worldscrawl/`, or the Map server URL setting)

Every call takes `?world=<id>`. The server keeps no chat state: the browser sends the chat's `changes` (patches) and `now` (time stamp) with each call that needs them.
| Endpoint | Caller | Sends | Gets back |
|---|---|---|---|
| GET /health | ext | – | ok, world, map_version, counts, start |
| GET /worlds | ext | – | default, worlds[] (info, has_knowledge) |
| GET /worlds/:id/knowledge | ext expiry | – | knowledge {location, stood, seen…} |
| POST /worlds/render | ext | id, id_hint, name, base, auto, overwrite | the new world |
| GET /start, GET/POST /rooms | ext | addresses, (changes) | start, rooms[], unknown[] |
| GET /location/:addr | ext doors | – | one room |
| POST /resolve | ext | changes | the resolved place |
| POST /move | ext | from, direction, changes | room + travel_seconds (+ traversal) |
| POST /travel | ext | from, steps, changes | path / rooms |
| POST /nearby | ext | from, depth, limit, changes | nearby rooms |
| POST /doors | ext | doors, changes | exits revealed |
| POST /discover/context | ext | location, changes | name, description, expandable, area facts |
| POST /aftermath | ext | address | what happens after a temporary change ends |
| POST /patch/preview | ext + map | patch, changes | preview / diff |
| POST /patch/context | ext + map | location, rooms, changes | area context for writing patches |
| POST /changes/status, /changes/dependents | ext | changes | failed[] / dependents |
| GET /cast, POST /cast/places | ext + map | changes | npcs, problems, places, labels |
| POST /cast/export, /cast/save, /cast/delete | ext / castpanel | an NPC record | the saved file |
| POST /edit/context, /edit/outline, /edit/ai-context | map | target, changes | data for the editor form |
| GET/POST /inspect, GET /inspect/index | ext + map | target | inspector rows |
| GET /prompts/active (+ prompt editor routes) | ext + map | – | prompts |
| POST /open-folder, POST /cache/clear, GET /cache | ext / map / none | – | ok |

