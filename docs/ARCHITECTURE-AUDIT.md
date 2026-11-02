# WorldScrawl architecture audit (read-only, master 5af0e24)

## The short version (plain language)
WorldScrawl has two halves. The **extension** runs in the browser inside SillyTavern and holds the chat. The **plugin** runs on the server, knows the map, and answers questions. The split mostly matches the rules: the server keeps no chat state and works from the patches and stamps it's sent. The problems are mostly **copies**: the same code exists on both sides with nothing keeping the copies in sync.

1. **Copied files.** `npc.mjs`, `actors.mjs` and `prompts.mjs` each exist twice. A test checks that the copies match, so they can't drift silently, but they're still copies.
2. **Server keeps code it never runs.** The server never imports its own `plugin/actors.mjs`; only tests do. Its `npc.mjs` is about 90 functions, and the server uses about 8 of them.
3. **npcPlayState is already in the right place.** It's only called in the browser (`extension/scene.mjs:438`). The server never calls it. The cast window only *shows* its result. It's chat-driven logic, so it belongs in the browser, and nothing needs to move.
4. **Small rules defined several times:** the "slug" rule (turning a name into an id), the id-format checks and "can you see where this exit leads" (`revealsDestination`).
5. **Unused endpoints:** the server has 30 routes. Some are only used by the map window and some by nothing. See the API map.
6. **Recommendation:** create one `shared/` folder that the plugin serves to the browser (option a). The extension *already* loads five of the plugin's files from the server at runtime, so this adds no new dependency. It just makes the existing one official.
7. **The plan:** 9 small PRs (pull requests: one reviewable change each), mostly pure moves with no behavior change. Each keeps the snapshot and coverage gates.

## 1. Module map: where each file actually runs
| Group | Runs in | Files | Job |
|---|---|---|---|
| extension/* | Browser (SillyTavern page) | index.js (hub: imports everything, owns settings and state), scene, waits, discovery, looking, movement, brackets, doors, clock, footer, carriers, patches, expiry, mapwindow, activity, calllog, notices, words, timelabels, dig | All chat logic: reads the model's tags, cards, NPC scene state, clock, movement, talks to the server via `api()` |
| extension/npc.mjs, actors.mjs, prompts.mjs | Browser | Copies of plugin/npc.mjs, plugin/actors.mjs and plugin/ui/prompts.mjs (identical except the header) | Copies, because the extension can't import plugin files when it loads |
| plugin/{index,server,world,cast,changes,editctx,inspect,movenotes,position,snapcache,weather-config,prompts,ui}.mjs | Node (server) | server.mjs holds the route table; world handles map loading; changes/snapcache apply patches; cast handles NPC files; prompts handles the prompt store; ui.mjs serves static files | Map data, applying patches, file I/O |
| plugin/npc.mjs | Node | Server uses: exportRecord, freeId, nameIn, NPC_ID, NPC_TOKEN, nearIndexFrom, npcTokenIds, validateRecord | Mostly a copy that serves the browser's needs |
| plugin/actors.mjs | **Nothing in the app**: only tests/node/actors.test.mjs imports it | | The test source for the extension's copy |
| plugin/ui/{calendar,patches,doorbar,weather,prompts}.mjs | **Both** the server (imported by server/world/changes/editctx/snapcache/weather-config) and the browser (map window, plus the extension through `import(baseUrl()/ui/…)`) | | **Already shared code, in practice** |
| plugin/ui/{app.js, activitylog, castdata, castpanel, changeedit, diffview, mapactions, mapdata, menus, patchform, picker, placeform, prompteditor} | Browser: the map/cast popup window. The extension also imports patchform and diffview | | Map, cast and editor user interface |

## 2. Duplicated logic
| What | Where | Really shared or ask the other side? | Action |
|---|---|---|---|
| NPC rules (npc.mjs) | extension and plugin, full copy | Really shared (the server validates, the browser plays) | Move to shared/npc.mjs, delete both copies |
| Actors and positions (actors.mjs) | extension, plus a plugin copy only tests use | Browser-only in practice | Keep it in the extension; tests import it from there; delete the plugin copy |
| Prompt text (prompts.mjs) | extension/prompts.mjs, plus plugin/ui/prompts.mjs, which the extension *also* loads at runtime and fills (doors.mjs:121) | Same module loaded twice | Use only the served one (shared/prompts.mjs); the text stays in plugin/prompts/default.json |
| Slug (name → id) | extension/index.js:395, npc.mjs:92 (×2), plugin/server.mjs:40 `slugify` (48 characters, falls back to 'world') | Same rule, different length limit and fallback | One `slug(s,{max,fallback})` in shared/ids.mjs |
| Id formats | NPC_ID in npc.mjs and plugin/ui/castdata.mjs:6; SLUG in world.mjs:20 and ui/patches.mjs:67 | Really shared | shared/ids.mjs |
| revealsDestination | extension/movement.mjs:88 and plugin/ui/mapdata.mjs:29, identical | Really shared | shared/exits.mjs |
| Time and calendar | Extension loads plugin/ui/calendar.mjs from the server (clock.mjs); timelabels.mjs has its own day/hour/minute formatting | Mostly already shared | Use calendar for the labels, or keep timelabels as display-only (low value) |
| Nearby places | Server: nearIndexFrom plus POST /cast/places (computed from the patches it's sent). Browser: refreshLivePlaces calls /cast/places | The browser correctly asks the server | No change |
| Tag parsing | extension/words.mjs (WAIT_TAG, normalizeWsTags), the *_FLAG_TAG regexes in npc.mjs, FLAG_TAG in extension/patches.mjs:20 | Browser-only (the server never parses chat tags) | Gather them in extension/tags.mjs; this is an ordering cleanup, not a sharing problem |

## 3. Misplaced responsibilities and dead code
- **npcPlayState** is called only at extension/scene.mjs:438. The server never calls it, and castdata.mjs:266 only displays its `why`. **It belongs in the browser.** It stays in npc.mjs because it shares helpers with the NPC rules (framesOf and others). It's legitimate.
- **No engine text-matching is driving state on the server.** Server routes only use patches, stamps and the map.
- **Dead or unused code, found by tooling** (knip 5 on a temporary copy, with tests counted as entry points so test-only code isn't flagged):
  - **plugin/actors.mjs:** the app never uses it. Only a test does.
  - **Endpoints with no caller in extension/ or plugin/ui:**
    - `GET /cache` (possibly used manually or in e2e)
    - `POST /cast/save` and `POST /cast/delete`: likely called by castpanel through an `io` wrapper, so check before removing
  - **knip "unused exports":** about 200 names. Most of them are only used *inside* their own file, so the `export` keyword is unnecessary but the code isn't dead. Real candidates:
    - prompts.mjs: loadPrompts, placeholdersIn
    - npc.mjs: loreBlock, loreIndexLine
    - inspect.mjs: placeRows, findExit, exitRows
    - mapactions.mjs: findSub, findRegion, allRooms
    - plugin/world.mjs: loadElsewhere, room_token
    - menus.mjs: closeToolView
    - notices.mjs: busy
  - **c8 (code that never runs in unit tests):**
    - Under 30% of lines: discovery 15%, footer 19%, scene 19%, waits 19%, mapactions 20%, mapwindow 28%, looking 28%, patches 29%, and extension/npc 26%. That last one is only low because tests use the plugin copy. These are DOM/chat glue that e2e covers. **c8 can't prove they're dead.**

## 4. Target architecture
```
shared/      pure logic, no DOM, no Node, no fetch: npc, ids, exits, calendar, weather, patches, doorbar, prompts
plugin/      Node server: routes, files, world loading (imports ../shared)
plugin/ui/   map-window UI only (browser)
extension/   chat-side browser code; imports shared/ from the server at runtime
```
**Option (a): the plugin serves shared/ at `/shared/*`. Recommended.** The extension already depends on this at runtime: it loads calendar, weather, patches, patchform, diffview and prompts from `baseUrl()/ui/`. When the server is down it can't do anything useful anyway, so this adds no new failure mode. There's one copy, tests import it directly, and nothing to keep in sync.
- The cost: npc.mjs is currently loaded statically. It would become an awaited dynamic import at startup, with the same pattern as loadCalendar.

**Option (b): run.sh copies shared/ to both sides, plus a check that the copies match.** This keeps a static import but brings back copies and a build step. You'd also need the "copies match" check permanently. It's better only if the extension must work without the plugin, and today it can't.

**Purity test (tests/node/shared-pure.test.mjs).**
- Parse each shared/*.mjs with acorn and fail on any of these:
  - imports outside shared/, or any `node:` import
  - the identifiers `window`, `document`, `fetch`, `localStorage`, `process`, `require`, `Buffer`, `globalThis.`, `XMLHttpRequest`, `BroadcastChannel`
- Also import each module under Node with those globals undefined, as a smoke test.

### Ruling applied (Knarfy, Nov 2): the extension is dead without the server
- Relying on the server costs nothing, so **option (a) is the default**.
- Option (b) has no remaining advantage. Its "works without the plugin" case doesn't exist.
- Every "ask the server" row above stands as written. The /cast/places pattern is the model to follow.

**The fixed-path concern (Map server URL setting).**
- `baseUrl()` (extension/index.js:90) is either the user's `serverUrl` setting or PLUGIN_URL. It's read at runtime.
- A static `import … from '/api/plugins/worldscrawl/shared/npc.mjs'` would hard-wire the default path. It would break anyone who points the setting at another server, and the browser could even load shared/ from one server while sending API calls to another.
- So shared/ must be loaded with **`await import(`${baseUrl()}/shared/x.mjs`)`**, the existing loadCalendar pattern, after settings load. It needs a single `loadShared()` at startup that:
  - shows the existing "server not running" message if the import fails
  - reloads if serverUrl changes
- Code that uses npc.mjs today at module top level must then wait until the shared modules are loaded. That's the main work and risk in PR 6.
- SillyTavern itself doesn't get in the way: plugins can serve static files, and the extension already does this five times.

## 5. Proposed CODEMAP section: the API (all calls take `?world=`; the browser sends `changes` and `now`; the server stores nothing per chat)
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

## 6. Phased PR plan (one kind of change per PR, gates: snapshot + c8 ≥ baseline)
| # | PR | Behavior change? | Risk | Size |
|---|---|---|---|---|
| 1 | Docs only: add the API section to CODEMAP | No | None | S |
| 2 | Tests only: shared-purity test (skipped while shared/ is empty), tests import extension/actors.mjs | No | Low | S |
| 3 | Delete plugin/actors.mjs (dead) | No | Low | XS |
| 4 | Server serves `/shared/*` (new static route, nothing uses it yet) | Adds a route | Low | S |
| 5 | Pure move: plugin/ui/{calendar,weather,patches,doorbar,prompts} → shared/, with re-export stubs left at the old paths | No | Medium (import paths) | M |
| 6 | Pure move: npc.mjs → shared/npc.mjs; the extension loads it via `loadShared()` from `${baseUrl()}/shared/` (respects the server URL setting); delete both copies and the copy-check test | Startup order only | Medium-High (startup) | M |
| 7 | shared/ids.mjs (slug, NPC_ID, SLUG) and shared/exits.mjs (revealsDestination); switch callers over | No (the slug limit and fallback become parameters) | Low-Medium | S |
| 8 | Remove the stubs from step 5; extension loads from /shared/ | No | Low | S |
| 9 | Dead-code pass: drop unneeded `export`s and the real unused functions; confirm the /cache and /cast/save callers first | No | Low | S |
Tests change only in their own PRs (2, and the test-import updates split out of 5/6), never alongside code changes.

## Technical appendix
- **Import graph:**
  - Server files that import plugin/ui: changes, snapcache, editctx, server, weather-config, world.
  - ui/patches imports calendar, doorbar and prompts; ui/weather imports calendar.
  - The extension loads these at runtime: clock.mjs loads calendar and weather; carriers.mjs loads patches; patches.mjs loads patchform and diffview; doors.mjs loads prompts.
- **npc.mjs exports (88):**
  - Used by both sides: 3
  - Plugin-only: 5
  - Extension-only: 46
  - Internal or unused: 34
- **Tooling:**
  - `npx knip@5` ran on /tmp/kn, a copy with a throwaway package.json and knip.json. The repo wasn't touched.
  - c8 json-summary: total lines 64.9%, branches 75.6%, functions 69.9%. There are 422 unit tests.
- **Known gaps:**
  - The knip endpoint results come from text search, so dynamic URL builders (castpanel `io`) may hide callers.
  - c8 doesn't cover e2e.
