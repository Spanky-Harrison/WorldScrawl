# Contributing: process, builds, PRs, tests

Read first every build: this page, then [CODEMAP.md](CODEMAP.md). Engine and behaviour rules are in [PRINCIPLES.md](PRINCIPLES.md); UI, naming and code style are in [STYLE.md](STYLE.md). Each rule lives in one place; the other pages link to it.

## Builds
1. A build starts only on Knarfy's explicit go. Kickoff order: Lead Dev posts the scope list, Ast. Dev critiques it, then Knarfy says go. Posting and merging finished PRs needs no extra go.
2. One theme per build. Minor bugs and tweaks are batched until they're worth a build (Lead Dev suggests one when there are enough). The exception is a critical bug that Knarfy authorizes a build for.
3. A started build runs to completion as planned, and changes are patched on top afterward. If the plan itself is wrong, kill the build and restart from a corrected plan.
4. Builds stay in-house.
5. Every v1 ships with its visibility features ([PRINCIPLES §Visibility](PRINCIPLES.md#visibility)).
6. Cloud agent runs report their fix rounds and usage.

## PRs
1. Never change code and tests in the same PR.
2. Pure moves (renames, file splits, relocations) go in their own PR, separate from behaviour changes.
3. Every PR must pass the prompt snapshot (`tests/e2e/snapshot.mjs`) and the coverage gate.
4. Any growth in the prompt snapshot must be justified in the PR body ([PRINCIPLES §Token budget](PRINCIPLES.md#token-budget)).
5. Every PR that adds or moves a file updates [CODEMAP.md](CODEMAP.md).
6. Each PR reports its test count and coverage change.
7. No backwards compatibility: assume a clean pull and a fresh chat. No migrations or legacy readers.
8. When a world-file format changes, update Riverton (`worlds/`) in the same PR.
9. Merge PRs once tests pass. A merge post flags any changed or new setting and gives the update steps: `git pull`, restart SillyTavern if `plugin/` or `worlds/` changed, then Ctrl+F5.

## Tests
1. Add tests to the existing topic files (listed in CODEMAP), not a new file per feature.
2. Unit tests by default (`node --test tests/node/*.test.mjs`). Use e2e (`tests/e2e/parts/NN-topic.part`) only when you need the real browser or server wiring.
3. An e2e check stays if it tests that things connect in the browser. It goes if it only retests logic a unit test already covers. Judge e2e cost by run time, not by check count.
4. Tests that guard a rule going forward stay. Checks that only prove a one-time change was safe (before/after comparisons, migration diffs, id checks after a rename) run once and are reported in the PR body, not kept.
5. e2e parts share one browser session and can't run alone; run them through `e2e/e2e.mjs`.
6. No retaining one-time tests.
7. No e2e check that could be a unit test.
8. While working, run only the tests that touch the change. Run the full e2e and the prompt snapshot once before merging; in a build, that's once at the end of the build, before the final merge.
