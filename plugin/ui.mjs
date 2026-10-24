// Static files for the WorldScrawl window (plugin/ui/), served at /api/plugins/worldscrawl/ui/. No build step.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const UI_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'ui');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json; charset=utf-8', '.ico': 'image/x-icon' };

/**
 * What to answer for a request path (relative to the plugin mount): null = not a UI path (the map API handles it),
 * {redirect}, {status: 404}, or {file, type}. Never serves anything outside plugin/ui/.
 */
export function uiFile(urlPath, dir = UI_DIR) {
    let p = String(urlPath ?? '').split('?')[0];
    try { p = decodeURIComponent(p); } catch { return { status: 404 }; }
    if (p === '/ui') return { redirect: 'ui/' };
    if (!p.startsWith('/ui/')) return null;
    let rel = p.slice(4) || 'index.html';
    if (rel.endsWith('/')) rel += 'index.html';
    if (rel.includes('\0') || rel.split(/[\\/]/).some(s => s === '..' || s.startsWith('.'))) return { status: 404 };
    const base = path.resolve(dir), file = path.resolve(base, rel);
    if (!file.startsWith(base + path.sep)) return { status: 404 };
    const type = TYPES[path.extname(file).toLowerCase()];
    if (!type || !fs.existsSync(file) || !fs.statSync(file).isFile()) return { status: 404 };
    return { file, type };
}
