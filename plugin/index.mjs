// SillyTavern server plugin: serves the WorldScrawl map API at /api/plugins/worldscrawl/.
// Install: link or copy this folder to SillyTavern/plugins/worldscrawl and set enableServerPlugins: true in config.yaml.
// Worlds folder: WORLDSCRAWL_WORLDS_DIR, else "worldsDir" in plugin/config.json (relative to this folder),
// else the repo's worlds/ folder next to this one.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from './server.mjs';
import { log } from './world.mjs';

const here = (() => { const d = path.dirname(fileURLToPath(import.meta.url)); try { return fs.realpathSync(d); } catch { return d; } })();

export const info = {
    id: 'worldscrawl',
    name: 'WorldScrawl',
    description: 'Map server for the WorldScrawl extension: rooms, exits, travel and saved worlds.',
};

/** The worlds folder to serve, as an absolute path. */
export function worldsDir(env = process.env, dir = here) {
    if (env.WORLDSCRAWL_WORLDS_DIR) return path.resolve(env.WORLDSCRAWL_WORLDS_DIR);
    const cfg = path.join(dir, 'config.json');
    if (fs.existsSync(cfg)) {
        try {
            const c = JSON.parse(fs.readFileSync(cfg, 'utf8').replace(/^\uFEFF/, ''));
            if (typeof c.worldsDir === 'string' && c.worldsDir.trim()) return path.resolve(dir, c.worldsDir.trim());
        } catch (e) { log.warning(`ignoring ${cfg} (${e.message})`); }
    }
    return path.resolve(dir, '..', 'worlds');
}

/** Express adapter: hand every request under the mount point to the framework-free handler. */
export function mount(router, server) {
    router.use((req, res) => {
        const body = req.is('application/json') ? req.body : undefined;
        const r = server.handle(req.method, req.url, body);
        for (const [k, v] of Object.entries(r.headers)) res.setHeader(k, v);
        res.status(r.status).json(r.body);
    });
}

export async function init(router) {
    let server;
    try {
        server = createServer({ defaultWorldsDir: worldsDir() });
        const s = server.state;
        log.info(`serving ${s.worlds.size} world(s) from ${s.rootDir ?? 'a single world folder'} (default: ${s.defaultId})`);
    } catch (e) {
        // Keep the routes up so the extension can say what is wrong instead of "not found".
        log.warning(`could not load worlds: ${e.message}`);
        const detail = `WorldScrawl could not load its worlds: ${e.message}`;
        server = { handle: () => ({ status: 503, headers: {}, body: { detail } }) };
    }
    mount(router, server);
}

export async function exit() {}

export default { info, init, exit };
