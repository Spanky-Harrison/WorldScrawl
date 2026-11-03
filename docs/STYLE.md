# UI and code style

How things look and behave on screen, plus naming and code style. Engine rules are in [PRINCIPLES.md](PRINCIPLES.md).

## In-chat notices
- All of a notice's buttons sit in one set on the right, at the end of the notice.
- The confirm button says **Approve**, never Keep.
- A notice waiting on the user shows `⏳ Waiting on you`.
- Decisions are saved per card id, so a second click does nothing.
- Temporary changes apply straight away and offer Edit/Undo. Lasting changes wait for Approve.
- Use `extension/notices.mjs` for every notice; don't hand-build layouts.

## Tags
- Tags the reader understands are hidden from the message and replaced by their notice.
- Tags it can't read stay visible, marked ⚠, and go in the log.

## Pickers, panels and forms
- Pickers show refused options and say why each one can't be chosen.
- Panels keep their drafts when closed or re-rendered.
- Live-tunable settings go in **Tools > Settings**, and changing one gets a heads-up in the merge post.

## Feedback
- Toasts are for short status: `error` when something failed and what to do, `info` for neutral status, `success` sparingly. A `warning` that refuses input appears only when the input is invalid or would break something, and it always says why (like pickers).
- Anything lasting or reviewable goes in a notice or the inspector, not in a toast.

## Commands and brackets
- Slash commands are `/ws-<verb>` in lowercase with hyphens (`/ws-found`, `/ws-wait`). Each has a bracket or menu equivalent where it makes sense, and `/ws-help` lists them all.

## Naming and ids
- Ids are lowercase with no apostrophes, made by the one `slug` rule in `plugin/shared/ids.mjs`.
- Memories and the inspector always use an NPC's real name. What the PC is allowed to know is handled by `{{tokens}}` and guard lines in the prompt.

## Code
- One topic per module, small files. `extension/index.js` is the hub; new logic goes in a topic module, not in index.js.
- Pure logic (no DOM or fetch) is kept apart from wiring so it can be unit-tested.
- Prompt text lives in `plugin/prompts/default.json`, not in code.
