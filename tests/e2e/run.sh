#!/bin/bash
# Headless end-to-end test: WorldScrawl server + fake model + throwaway SillyTavern (port 8767) + Chrome.
# Needs: ST_SRC (SillyTavern 1.19 with npm packages), Node 20, playwright-core on the module path, /usr/bin/google-chrome.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"; REPO="$(cd "$HERE/../.." && pwd)"
ST_SRC="${ST_SRC:-/workspace/SillyTavern-src}"
PY="${PY:-$REPO/.venv/bin/python}"
cleanup() { pkill -f "server.js --port 8767"; pkill -f "port 5199"; kill $FAKE 2>/dev/null; }
trap cleanup EXIT
rm -rf /tmp/st-ws /tmp/st-ws.yaml; mkdir -p /tmp/st-ws/default-user/extensions
cp -r "$REPO/extension" /tmp/st-ws/default-user/extensions/WorldScrawl
(cd "$REPO" && "$PY" -m uvicorn app.main:app --port 5199 > /tmp/ws-api.log 2>&1) & API=$!
node "$HERE/fake-openai.mjs" 9098 > /tmp/ws-fake.log 2>&1 & FAKE=$!
(cd "$ST_SRC" && node server.js --port 8767 --dataRoot /tmp/st-ws --configPath /tmp/st-ws.yaml > /tmp/st-ws.log 2>&1) & ST=$!
for i in $(seq 1 60); do curl -s -o /dev/null localhost:8767/csrf-token && break; sleep 2; done
sleep 3
node "$HERE/${E2E_SCRIPT:-e2e.mjs}"
