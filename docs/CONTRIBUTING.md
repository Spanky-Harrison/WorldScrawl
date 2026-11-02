# Contributing: standing rules

1. Builds start only on Knarfy's explicit go. Lead Dev posts the scope list, Ast. Dev critiques it, then Knarfy says go.
2. A started build runs to completion as planned; changes are patched on top. If the plan is wrong, kill the build and restart from a corrected plan.
3. Minor bugs and tweaks are batched until they are worth a build. One theme per build.
4. Never change code and tests in the same PR.
5. Add tests to existing topic files, not one new file per feature. Unit tests by default; e2e only when the real browser or server is needed.
6. Each PR reports its test count and coverage change.
7. Every PR that moves or adds a file updates docs/CODEMAP.md.
8. Narrative state changes come only from the player (brackets/commands) or the model (flags/tools), never from engine text matching.
9. Every feature ships with inspector visibility.
10. The player is omnipotent; guards apply to the model.
11. No backwards compatibility: assume a clean pull and a fresh chat each build.
