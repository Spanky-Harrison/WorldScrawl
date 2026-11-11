# Code map

Where things live. Every PR that moves or adds a file updates this page. Rules: [CONTRIBUTING.md](CONTRIBUTING.md) (process), [PRINCIPLES.md](PRINCIPLES.md) (engine), [STYLE.md](STYLE.md) (UI and code). Design notes: npc-design.md, lore.md.

## extension/ (SillyTavern UI extension; runs in the browser)

The manifest loads `index.js`. Everything else is an ES module that index.js imports. index.js re-exports what it used to export, so tests and e2e can keep importing from `index.js`.

| File | Owns | Entry points |
|---|---|---|
| index.js | Startup (`init`), on/off and settings access, world sync and the chat-to-world link, rebuilding from the chat, look/move actions and their pending state, expiry state, the prompt interceptor (`globalThis` hook), save-world, the map channel. It keeps every mutable state variable that `init` or more than one topic writes | `init` IIFE, `isOn`, `settings`, `syncWorld`, `saveWorld`, `rebuildFromChat`, `lookAction`, `moveAction`, `PLUGIN_URL`, `MAP_URL` |
| clock.mjs | Calendar, game clock, weather now, world/chat names, chat changes | `clockAt`, `gameDate`, `effectiveWorld`, `chatChanges` |
| doors.mjs | Door and bar state: open/closed, barred, sight and sound through doors | `doorStates`, `isOpenNow`, `isBarredNow`, `viewOf` |
| expiry.mjs | Narration when something expires (options, pick prompt, notice) | `expiryPickPrompt`, `expiredNotice`, `ensureStartStamp` |
| movement.mjs | Choosing a destination from model answers, step-taking, reveals | `parseChoice`, `pickKey`, `stepsTaken`, `applyReveals` |
| ownedcall.mjs | The timer around one side call. A late answer is dropped even if the provider cannot abort | `ownedCall` |
| dig.mjs | Digging up new places (prompt, answer reading, duplicate merge). `gen` uses `ownedCall` for every side call | `digPrompt`, `readDigAnswer`, `mergeDuplicates`, `gen` |
| looking.mjs | Look targets, door look, windows | `lookOptions`, `lookTargetPrompt`, `closedDoorPrompt` |
| brackets.mjs | Player brackets (`[look]`, `[move]`…) and help text | `parseBracket`, `bracketIntent`, `helpText` |
| scene.mjs | Scene/NPC tokens fed to the narrator, lore, the found notice and its Edit (`applyFound`, `judgeFoundNow`), live places from `POST /cast/places`, appearance rebuild side-call, the people list the tracker reads (`listedPeople`) | `renderTokens`, `applyFound`, `refreshLivePlaces`, `ensureAppearanceRebuilds`, `retryAppearance`, `listedPeople` |
| footer.mjs | Exits text and the footer shown under replies | `exitsText`, `namedNpcsAt` |
| mapwindow.mjs | Opening the map window, theme vars, map state, and the map channel (cast Changes card clicks go to `runGuiCardAction`; the inspector's Approve edited is `change_restamp`) | `openMapWindow`, `mapState` |
| patches.mjs | Map patches (lasting changes), a kept change's in-card Approve edited (`saveKeptEdit`, re-stamped on its message), the place expiry notice's before/now view and its Approve edited, and the `FLAG_TAG` / `ws_flag` wait hint | `previewOps`, `toggleChange`, `saveKeptEdit`, `expiryView`, `keepExpiryEdit`, `FLAG_TAG` |
| carriers.mjs | Carrier messages for changes, patch library, edit calls, flag cards | `snapCarriers`, `restoreCarriers`, `flagStatusText` |
| discovery.mjs | Discovery prompts, `ws_flag` handling on replies, tool registration, feeding tracker results into the place rewrite and person apply | `onReplyForFlags`, `flagMessage`, `registerTools`, `applyTrackerResult`, `onStorySwipe` |
| arearewrite.mjs | Light touch / full rewrite on place changes: which ops are existing text (`textTargets`), merging the rewrite answer (`mergeRewrite`) and the guard that refuses anything but text changing (`rewriteGuard`). No DOM, fetch or model calls (the call is `swapRewrite` in carriers.mjs) | `areaRewrite`, `textTargets`, `mergeRewrite`, `rewriteGuard` |
| tracker.mjs | After-reply tracker: the question, the answer reader, flag gates, and dropping a swipe's tracker stamps. No DOM or fetch | `shouldTrackReply`, `readTrackerAnswer`, `gateTracker`, `trackerPrompt`, `dropTrackerMarks` |
| waits.mjs | Waits: model and player waits, Approve/Discard, and `renderPatchCards`, which draws every in-chat card through the shared card (`drawCard`) | `planWait`, `proposeWait`, `renderPatchCards` |
| settings.mjs | The settings panel | `addSettingsPanel` |
| npc.mjs | NPC play: stamps, presence, schedules, flags and tags, lore, context slices, `judgeFound` / `foundEditOk` (browser only; the parts the server uses too are in plugin/shared/npc.mjs) | `framesOf` (temporary `lasts` fields and appearance effects expire in game time), `lastsMinutes`, `expiryOf`, `npcTarget`, `npcSlices`, `presentAt`, `comingsAndGoings` (arrivals, departures, and appearance-effect expiry lines), `relOf` / `relLine`, `takeNpcTags`, `recordDiff`, appearance stamps (`npc_appearance` / `npc_appearance_cache`) |
| npceffects.mjs | Appearance effects: base Looks/Body/Outfit plus active intents; rebuild (not peel); cheap non-overlap combine; already-shown / already-effect guards; plan/accept rebuild; classify a reply before any cache is written | `resolveAppearance`, `rebuildInputs`, `effectSetKey`, `effectFields`, `alreadyShown`, `alreadyEffect`, `planAppearanceRebuild`, `acceptAppearanceRebuild`, `readAppearanceAnswer`, `classifyAppearanceReply` |
| npcexpiry.mjs | Person temporary changes that ran out (appearance owners, temporary facts): the window the next reply has not narrated, the chat notice text, the narrator note, the tracker's "already done" lines, a wait's list | `personExpiriesBetween`, `expiryWindow`, `expiryNoticeText`, `expiryNarratorNote`, `trackerExpiryLines`, `changeLabel` |
| actors.mjs | Per-actor positions and the party (browser only; the server never needs them) | `positionOf`, `playerAddress`, `positionsAt` |
| shared.mjs | Loads plugin/shared/ once at startup from `<server>/shared/` (follows the Map server URL setting; a change reloads the page). If it fails, `sharedError` names the URL and startup shows it. Re-exports the prompt helpers (`render`, `setPrompts`, `hasPrompts`) | `calendar`, `patches`, `doorbar`, `weather`, `prompts`, `sharedError`, `sharedUrl` |
| words.mjs | Pure word checks and tag parsing (`LOOK_RE`, `MOVE_RE`, `WAIT_TAG`) | — |
| notices.mjs | Card decisions (decide-once per card id) and the `once()` guard | `markDecided`, `once` |
| cardlib.mjs | Loads the shared card and editor (plugin/ui/card.mjs, cardedit.mjs) at startup and checks their `CARD_VERSION`; a missing or older plugin gets one "update the plugin" line instead of cards | `cardLib`, `editLib`, `UPDATE_LINE`, `useCardLib` |
| cardacts.mjs | The card action layer: one handler table per card type (place, person incl. kept changes, expiry notices, remember, kept map changes, person notes, found rows, narrator waits, appearance rebuild jobs) and the ticket (stale) check every async action passes; map-window card clicks run the same handlers with the GUI's editor values | `runCardAction`, `runGuiCardAction`, `ticketFor`, `HANDLERS` |
| activity.mjs, calllog.mjs, timelabels.mjs | Activity log, model-call notes, game-time labels | — |
| manifest.json | SillyTavern extension manifest (entry `index.js`) | — |

## plugin/ (SillyTavern server plugin; Node)

| File | Owns |
|---|---|
| index.mjs | Plugin entry; mounts the API at `/api/plugins/worldscrawl/` |
| server.mjs | Framework-free API handler, routes incl. `POST /cast/places` |
| world.mjs, position.mjs, changes.mjs, snapcache.mjs | World loading/validation, position resolver, per-chat changes, map snapshot cache |
| npc.mjs | Server-only NPC code: `validateRecord` (cast file checks) and `nearIndexFrom` |
| cast.mjs | Cast files: load, save, export |
| prompts.mjs, prompts/default.json | Prompt profiles per user; the default prompt text for every model call |
| inspect.mjs, editctx.mjs, movenotes.mjs, weather-config.mjs, ui.mjs | Inspector data, edit-form context, move inheritance notes, weather config, static serving of plugin/ui/ (`/ui/*`) and plugin/shared/ (`/shared/*`) |
| climates/*.json, exit_types.json, sky_types.json, wind_levels.json | Data tables |
| config.example.json, package.json | Config template, package metadata |
| ui/ | The map window (browser only): `app.js` (entry), `index.html`, `app.css`, and modules: activitylog, card (the one card every review, change and notice uses: `renderCard`, button order and labels, row lock, Waiting on you frame), cardedit (the one editor: Change box, field boxes, hosted patch form, drafts that survive redraws), castdata (incl. `stampCard`: the shared card for each cast Changes row), castpanel (its Changes tab and the inspector's Changes tab in app.js show the shared cards, collapsed), diffview, mapactions, mapdata, menus, patchform, picker, placeform, prompteditor. The extension also imports patchform, diffview, card and cardedit from `/ui/` |
| shared/ | Code that runs on both sides: pure, no DOM, Node or fetch (tests/node/shared.test.mjs checks). The server imports it directly; the browser loads it from `/shared/*`. calendar (game time), weather, patches (map patches), doorbar (one-sided bars), prompts (prompt text renderer), npc (record basics both sides use: `exportRecord`, `freeId`, `nameIn`, `normName`, `NPC_ID`, `NPC_TOKEN`, schedules' place lookup), exits (`revealsDestination`), cards (card descriptors per type and the action matrix: `placeReview`, `personReview`, `ACTIONS`), ids (`slug`: the one name-to-id rule; server `slugify`, `freeId` and new room addresses use it). Ids: `SLUG` (place ids) is in patches, `NPC_ID` in npc |

## tests/

| Path | What |
|---|---|
| node/*.test.mjs | Unit tests, one file per topic (run `node --test tests/node/*.test.mjs`): actors, arearewrite (light touch / full rewrite on place cards, through the real card and map server), barred, cards (the shared card, editor, descriptors and action layer: skeleton, button order, redraw drafts, stale tickets, the update-the-plugin line), calllog, cast, dig, discover, exits, expiry, flags, inspect, liveplaces (the browser refresh through `api()`'s `{ok, status, body}` wrapper), mapactions, modeledits, notices, npc (incl. NPC card, live schedule/places, lore), patches (incl. patch form, toggles, diff view, move diff, change editor), placeform, placeless, position, prompts, snapcache, time, ui (incl. menus, picker), wait, weather, words (incl. brackets, carriers), world (incl. slugs, bases), worlds. Merged files keep each original file's tests in its own `{ }` block under a `// ---- from <old file>` comment. Helpers: `helpers.mjs` (incl. `extSource()`), `ststub.mjs` (SillyTavern stub), `fakedom.mjs` (a tiny DOM for card clicks), `useprompts.mjs`, `fixtures/` |
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

