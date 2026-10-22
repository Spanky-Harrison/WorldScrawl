#!/bin/bash
# Headless end-to-end test: throwaway SillyTavern (port 8767) with the WorldScrawl server plugin + fake model + Chrome.
# Needs: ST_SRC (SillyTavern 1.19 with npm packages), Node 20, playwright-core on the module path, /usr/bin/google-chrome.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"; REPO="$(cd "$HERE/../.." && pwd)"
ST_SRC="${ST_SRC:-/workspace/SillyTavern-src}"
PLUGIN="$ST_SRC/plugins/worldscrawl"
cleanup() { pkill -f "server.js --port 8767"; kill $FAKE 2>/dev/null; rm -rf "$PLUGIN"; }
trap cleanup EXIT
rm -rf /tmp/st-ws /tmp/st-ws.yaml; mkdir -p /tmp/st-ws/default-user/extensions
cp -r "$REPO/extension" /tmp/st-ws/default-user/extensions/WorldScrawl
rm -rf "$PLUGIN" && cp -r "$REPO/plugin" "$PLUGIN"  # ST loads server plugins from its own plugins/ folder
sed -e 's/^enableServerPlugins: false/enableServerPlugins: true/' -e 's/^enableServerPluginsAutoUpdate: true/enableServerPluginsAutoUpdate: false/' \
    "$ST_SRC/default/config.yaml" > /tmp/st-ws.yaml
rm -rf /tmp/ws-worlds && cp -r "$REPO/worlds" /tmp/ws-worlds  # saved worlds go to a scratch copy
node "$HERE/fake-openai.mjs" 9098 > /tmp/ws-fake.log 2>&1 & FAKE=$!
(cd "$ST_SRC" && WORLDSCRAWL_WORLDS_DIR=/tmp/ws-worlds WORLDSCRAWL_NO_OPEN=1 node server.js --port 8767 --dataRoot /tmp/st-ws --configPath /tmp/st-ws.yaml > /tmp/st-ws.log 2>&1) & ST=$!
for i in $(seq 1 60); do curl -s -o /dev/null localhost:8767/csrf-token && break; sleep 2; done
sleep 3
grep -q "WorldScrawl" /tmp/st-ws.log || { echo "WorldScrawl plugin did not load; see /tmp/st-ws.log"; exit 1; }
node "$HERE/${E2E_SCRIPT:-e2e.mjs}"
