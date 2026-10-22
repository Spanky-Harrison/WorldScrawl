import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from '../../plugin/server.mjs';
import { log } from '../../plugin/world.mjs';

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const ROOT = path.join(REPO, 'worlds', 'riverton');
export const RIVERTON = ROOT;
export const TAVERN = 'riverton:drowned_rat/common_room';
export const SQUARE = 'riverton:streets/square';
export const YARD = 'riverton:drowned_rat/courtyard';

/** A fresh temp folder (pytest's tmp_path), removed after the test run. */
export function tmpPath() {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-test-'));
    process.on('exit', () => fs.rmSync(d, { recursive: true, force: true }));
    return fs.realpathSync(d);
}
export const mkdir = p => { fs.mkdirSync(p); return p; };
export const write = (p, s) => fs.writeFileSync(p, s);
export const read = p => fs.readFileSync(p, 'utf8');
export const copytree = (a, b) => fs.cpSync(a, b, { recursive: true });

export function makeWorld(dir, regions, startRegion = 'r', raw = {}) {
    fs.mkdirSync(path.join(dir, 'regions'));
    write(path.join(dir, 'world.json'), JSON.stringify({ start_region: startRegion }));
    for (const [rid, data] of Object.entries(regions)) write(path.join(dir, 'regions', `${rid}.json`), JSON.stringify(data));
    for (const [name, text] of Object.entries(raw)) write(path.join(dir, 'regions', name), text);
    return dir;
}

/** In-process client for the plugin's handler, shaped like FastAPI's TestClient. */
export class TestClient {
    constructor(opts) { this.server = createServer({ env: { WORLDSCRAWL_NO_OPEN: '1' }, ...opts }); }
    request(method, url, { json, params } = {}) {
        const u = new URL(url, 'http://x');
        for (const [k, v] of Object.entries(params ?? {})) u.searchParams.set(k, v);
        const r = this.server.handle(method, u.pathname + u.search, json === undefined ? undefined : JSON.parse(JSON.stringify(json)));
        const headers = Object.fromEntries(Object.entries(r.headers).map(([k, v]) => [k.toLowerCase(), v]));
        return { status_code: r.status, headers: { get: k => headers[k.toLowerCase()] ?? null }, json: () => JSON.parse(JSON.stringify(r.body)) };
    }
    get(url, o) { return this.request('GET', url, o); }
    post(url, o) { return this.request('POST', url, o); }
}
/** Address paths as the browser sends them: "/location/riverton:x/y" works unencoded too. */
export const client = worldDir => new TestClient({ worldDir });
export const clientDir = worldsDir => new TestClient({ worldsDir });

/** Capture log lines while fn runs (pytest's caplog). */
export function caplog(fn) {
    const lines = [], { info, warning } = log;
    log.info = (...a) => lines.push(a.join(' '));
    log.warning = (...a) => lines.push(a.join(' '));
    try { return [fn(), lines.join('\n')]; } finally { Object.assign(log, { info, warning }); }
}
