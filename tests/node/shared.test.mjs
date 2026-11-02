// shared/ stays pure: it is loaded by the Node server and by the browser, so it may only import other shared/ files
// and may not touch DOM, Node, fetch or similar host-only globals. Each file must also load with those globals gone.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const dir = fileURLToPath(new URL('../../shared/', import.meta.url));
const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => /\.m?js$/.test(f)) : [];
const BANNED = ['window', 'document', 'navigator', 'location', 'localStorage', 'sessionStorage', 'fetch', 'XMLHttpRequest',
    'WebSocket', 'BroadcastChannel', 'Worker', 'process', 'require', 'module', '__dirname', '__filename', 'Buffer',
    'global', 'setImmediate', 'jQuery', '$', 'toastr', 'SillyTavern'];
let acorn = null, walk = null;
try { acorn = await import('acorn'); walk = await import('acorn-walk'); } catch { /* not installed: the parse check is skipped */ }

test('shared/ files import only other shared/ files and use no host-only globals', { skip: !acorn && 'acorn / acorn-walk not installed' }, () => {
    for (const f of files) {
        const src = fs.readFileSync(path.join(dir, f), 'utf8');
        const ast = acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'module' });
        const bad = [];
        const checkSource = s => {
            if (typeof s !== 'string') { bad.push('computed import'); return; }
            if (s.startsWith('node:') || !s.startsWith('.')) { bad.push(`import ${s}`); return; }
            if (!path.resolve(dir, s).startsWith(dir)) bad.push(`import ${s} (outside shared/)`);
        };
        walk.fullAncestor(ast, (node, _st, anc) => {
            if (['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration'].includes(node.type) && node.source) checkSource(node.source.value);
            if (node.type === 'ImportExpression') checkSource(node.source.type === 'Literal' ? node.source.value : null);
            if (node.type === 'MetaProperty') bad.push('import.meta');
            if (node.type !== 'Identifier' || !BANNED.includes(node.name)) return;
            const parent = anc[anc.length - 2];
            if (parent?.type === 'MemberExpression' && parent.property === node && !parent.computed) return; // x.fetch
            if (parent?.type === 'Property' && parent.key === node && !parent.computed && !parent.shorthand) return; // { fetch: 1 }
            if (parent?.type === 'MethodDefinition' && parent.key === node) return;
            bad.push(`global ${node.name}`);
        });
        assert.deepEqual(bad, [], `shared/${f}`);
    }
});

test('every shared/ file loads under Node with host-only globals undefined', () => {
    for (const f of files) {
        const script = `for (const n of ${JSON.stringify(BANNED)}) { try { Object.defineProperty(globalThis, n, { value: undefined, configurable: true, writable: true }); } catch {} }
            await import(${JSON.stringify(pathToFileURL(path.join(dir, f)).href)});`;
        assert.doesNotThrow(() => execFileSync(process.execPath, ['--input-type=module', '-e', script], { stdio: 'pipe' }), `shared/${f}`);
    }
});
