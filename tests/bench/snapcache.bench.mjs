// node tests/bench/snapcache.bench.mjs — replay timing on ~500 patches, full vs cached.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SnapshotCache } from '../../plugin/snapcache.mjs';
import { read_world_raw } from '../../plugin/world.mjs';
import { apply_changes } from '../../plugin/changes.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'worlds', 'riverton');
const [WJ, RAW] = read_world_raw(ROOT);
const N = 500;
const ch = Array.from({ length: N }, (_, i) => ({ type: 'patch', id: `p${i}`, at: i, _msg: i + 1, swipe: 0,
    ops: [{ op: 'create_place', area: 'riverton:streets', id: `b_${i}`, name: `B ${i}`, description: 'x', exits: [{ direction: `b_${i}`, to: 'riverton:streets/square', return_direction: 'back' }] }] }));
const t = f => { const s = performance.now(); f(); return performance.now() - s; };
const ms = x => `${x.toFixed(1)} ms`;
const fullT = t(() => apply_changes(WJ, RAW, ch, { lenient: true, info: { patches: [] } }));
const c = new SnapshotCache();
const cold = t(() => c.build('w', WJ, RAW, ch, 0));
const hit = t(() => c.build('w', WJ, RAW, ch, 0));
const add = t(() => c.build('w', WJ, RAW, [...ch, { ...ch[0], id: 'new', _msg: N + 1, ops: [{ ...ch[0].ops[0], id: 'new_one', exits: [] }] }], 0));
const del = t(() => c.build('w', WJ, RAW, ch.filter((_, i) => i !== N - 10), 0));
console.log(JSON.stringify({ patches: N, full_replay: ms(fullT), cache_cold: ms(cold), cache_hit: ms(hit), new_message: ms(add), deleted_near_end: ms(del) }));
