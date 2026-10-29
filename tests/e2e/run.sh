#!/bin/bash
# Headless end-to-end test: throwaway SillyTavern (port 8767) with the WorldScrawl server plugin + fake model + Chrome.
# Needs: ST_SRC (SillyTavern 1.19 with npm packages), Node 20, playwright-core on the module path, /usr/bin/google-chrome.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"; REPO="$(cd "$HERE/../.." && pwd)"
ST_SRC="${ST_SRC:-/workspace/SillyTavern-src}"
PLUGIN="$ST_SRC/plugins/worldscrawl"
# Own ports and scratch dirs so parallel runs (other worktrees) do not collide: E2E_PORT, E2E_FAKE_PORT, E2E_TMP.
PORT="${E2E_PORT:-8767}"; FPORT="${E2E_FAKE_PORT:-9098}"; T="${E2E_TMP:-/tmp}"
export E2E_PORT="$PORT" E2E_FAKE_PORT="$FPORT" E2E_TMP="$T"
cleanup() { pkill -f "server.js --port $PORT "; kill $FAKE 2>/dev/null; rm -rf "$PLUGIN"; }
trap cleanup EXIT
rm -rf $T/st-ws $T/st-ws.yaml; mkdir -p $T/st-ws/default-user/extensions
cp -r "$REPO/extension" $T/st-ws/default-user/extensions/WorldScrawl
rm -rf "$PLUGIN" && cp -r "$REPO/plugin" "$PLUGIN"  # ST loads server plugins from its own plugins/ folder
sed -e 's/^enableServerPlugins: false/enableServerPlugins: true/' -e 's/^enableServerPluginsAutoUpdate: true/enableServerPluginsAutoUpdate: false/' \
    "$ST_SRC/default/config.yaml" > $T/st-ws.yaml
rm -rf $T/ws-worlds && cp -r "$REPO/worlds" $T/ws-worlds  # saved worlds go to a scratch copy
node "$HERE/fake-openai.mjs" $FPORT > $T/ws-fake.log 2>&1 & FAKE=$!
(cd "$ST_SRC" && WORLDSCRAWL_WORLDS_DIR=$T/ws-worlds WORLDSCRAWL_NO_OPEN=1 node server.js --port $PORT --dataRoot $T/st-ws --configPath $T/st-ws.yaml > $T/st-ws.log 2>&1) & ST=$!
for i in $(seq 1 60); do curl -s -o /dev/null localhost:$PORT/csrf-token && break; sleep 2; done
sleep 3
grep -q "WorldScrawl" $T/st-ws.log || { echo "WorldScrawl plugin did not load; see $T/st-ws.log"; exit 1; }
node "$HERE/${E2E_SCRIPT:-e2e.mjs}"
