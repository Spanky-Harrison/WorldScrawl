// Pure helpers for the play-mode map: which rooms the chat knows, and where to draw them. No DOM; unit-tested in node.

/** Where the party marker goes: the player's position. `location` is that same address; `positions.player` is it once positions are per actor. The id matches PLAYER in actors.mjs (this file cannot import outside plugin/ui/). */
export const partyHere = state => {
    const p = state?.positions;
    const at = p && typeof p.player === 'string' && p.player ? p.player : null;
    return at ?? (typeof state?.location === 'string' && state.location ? state.location : null);
};

/** Chat changes with each two-way dig split into its two one-way exits. */
export function expandChanges(changes = []) {
    return (changes ?? []).flatMap(c => c?.type !== 'dig' ? [c]
        : [{ type: 'add_exit', from: c.from, direction: c.direction, to: c.to, description: c.description },
           ...(c.return_direction && !c.oneway ? [{ type: 'add_exit', from: c.to, direction: c.return_direction, to: c.from, description: c.return_description }] : [])]).filter(Boolean);
}

/** Rooms this chat created (add_room changes), as minimal room objects. */
export function newRooms(changes, rooms) {
    const out = new Map();
    for (const c of expandChanges(changes)) if (c.type === 'add_room' && c.address && !rooms.has(c.address)) {
        const near = rooms.get(c.from);
        out.set(c.address, { address: c.address, name: c.name ?? c.address, description: c.description ?? '', exits: [], views: [],
            subregion: near?.subregion ?? {}, region: near?.region ?? {}, new_room: true });
    }
    return out;
}

const lc = s => String(s ?? '').toLowerCase();
export const revealsDestination = e => !(e?.hidden || e?.obscured) || !!e?.revealed;

/**
 * A room as this chat knows it: exits behind passed doors get their destination (from POST /doors data:
 * reveals = [{from, direction, to, to_name, ...}]), dug exits are added and removed exits dropped.
 * rooms: address -> server room (for naming dug destinations).
 */
export function knownRoom(loc, { changes = [], reveals = [], rooms = new Map() } = {}) {
    if (!loc) return loc;
    let exits = (loc.exits ?? []).map(e => {
        if (!(e.hidden || e.obscured)) return e;
        const r = reveals.find(x => x.from === loc.address && lc(x.direction) === lc(e.direction));
        return r && r.to ? { ...e, ...r, revealed: true } : e;
    });
    for (const c of expandChanges(changes)) {
        if (c.from !== loc.address) continue;
        if (c.type === 'remove_exit') exits = exits.filter(e => lc(e.direction) !== lc(c.direction));
        else if (c.type === 'add_exit' && c.to && !exits.some(e => lc(e.direction) === lc(c.direction))) {
            const t = rooms.get(c.to);
            if (!t) continue; // not in this world (or not fetched): skipped, as in the chat
            exits.push({ direction: c.direction, to: t.address, to_name: t.name, to_subregion: t.subregion, to_region: t.region, ...(c.description ? { description: c.description } : {}), dug: true });
        }
    }
    return { ...loc, exits };
}

/** Is this exit a closed door right now? */
export function isClosed(e, open = [], closed = []) {
    if (!(e?.barrier)) return false;
    if (e.door && closed.includes(e.door)) return true;
    if (e.door && open.includes(e.door)) return false;
    return !e.barrier?.starts_open;
}
/** A barrier that can't be opened at all (a cave-in, a barricade). */
export const isBlocked = e => e?.barrier?.openable === false;
/** Region id + name of a room ("region:sub/loc" addresses carry the region id when the room data doesn't). */
const areaOf = (a, reg) => ({ regionId: reg?.id ?? (String(a).includes(':') ? String(a).split(':')[0] : ''), region: reg?.name ?? '' });
const firstSentence = t => String(t ?? '').trim().split(/(?<=[.!?])\s/)[0].slice(0, 200);

/**
 * The play-mode graph. Only discovered places: rooms stood in (full detail and exits) and rooms seen
 * (name, area and a one-line summary; never their exits). An exit that does not reveal where it leads is a
 * stub node carrying only its label. state: {location, positions?: {player}, stood[], seen[], doors_open[]}; rooms: address -> known room.
 * The party marker (`here`) is the player. `location` is that address when `positions` is absent.
 * An exit pair is one line: a hidden or obscured side whose other side is in a room stood in (the player has been
 * to its destination) joins that room instead of becoming a stub. With mark (the editor and pick mode) a revealed
 * hidden or obscured side carries obscured: true, drawn as a "?" on that end.
 */
export function buildGraph(state, rooms, { mark = false } = {}) {
    const stood = new Set(state?.stood ?? []), nodes = new Map(), edges = [];
    const here = partyHere(state);
    if (here) stood.add(here);
    const open = state?.doors_open ?? [], shut = state?.doors_closed ?? [];
    const sub = r => ({ id: r?.subregion?.id ?? '', name: r?.subregion?.name ?? '' });
    for (const a of stood) {
        const r = rooms.get(a);
        if (r) nodes.set(a, { id: a, kind: 'stood', name: r.name, subregion: sub(r), ...areaOf(a, r.region), description: r.description ?? '', pos: r.pos ?? null, here: a === here,
            subEntrance: r.subregion?.entrance ?? '', regionEntrance: r.region?.entrance ?? '' });
    }
    const addSeen = (a, name, s, summary = '', reg = null, r = null) => {
        if (!a || nodes.has(a)) return;
        nodes.set(a, { id: a, kind: 'seen', name: name ?? a, subregion: { id: s?.id ?? '', name: s?.name ?? '' }, ...areaOf(a, reg), description: summary, pos: r?.pos ?? null, here: false,
            subEntrance: (r?.subregion ?? s)?.entrance ?? '', regionEntrance: (r?.region ?? reg)?.entrance ?? '' });
    };
    for (const a of state?.seen ?? []) { const r = rooms.get(a); if (r) addSeen(a, r.name, r.subregion, firstSentence(r.description), r.region, r); }
    // The other side of a door, in a room stood in: door id -> that room's address.
    const otherSide = new Map();
    for (const a of stood) for (const e of rooms.get(a)?.exits ?? []) if (e.door && e.to) { const k = e.door; if (!otherSide.has(k)) otherSide.set(k, []); otherSide.get(k).push({ at: a, to: e.to }); }
    const pairedRoom = (a, e) => (e.door ? (otherSide.get(e.door) ?? []).find(x => x.at !== a && x.to === a)?.at ?? null : null);
    for (const a of stood) {
        const r = rooms.get(a);
        if (!r) continue;
        for (const e of (r.exits ?? []).filter(e => !e.hidden || e.revealed || pairedRoom(a, e))) { // an unrevealed hidden exit is a secret: not even a stub
            const closed = isClosed(e, open, shut), blocked = isBlocked(e), locked = closed && !!e.barrier?.locked;
            const via = revealsDestination(e) && e.to ? e.to : pairedRoom(a, e);
            if (via) {
                const t = rooms.get(via);
                addSeen(via, e.to_name ?? t?.name, e.to_subregion ?? t?.subregion, '', e.to_region ?? t?.region, t);
                edges.push({ from: a, to: via, direction: e.direction, closed, blocked, locked, dug: !!e.dug, description: e.description ?? '', ...(mark && (e.hidden || e.obscured) ? { obscured: true } : {}) });
            } else { // unrevealed: label only, the destination stays unknown
                const id = `stub:${a}|${lc(e.direction)}`;
                nodes.set(id, { id, kind: 'stub', name: e.direction, subregion: { id: '', name: '' }, region: '', description: '', pos: null, here: false });
                edges.push({ from: a, to: id, direction: e.direction, closed, blocked, locked, dug: false, description: e.description ?? '' });
            }
        }
    }
    for (const n of nodes.values()) if (n.kind === 'seen' && !n.description) { const r = rooms.get(n.id); if (r) n.description = firstSentence(r.description); }
    // A pair of exits between two rooms is one line with both labels.
    const merged = [];
    for (const e of edges) {
        const back = merged.find(m => m.from === e.to && m.to === e.from && !m.back);
        if (back) back.back = e; else merged.push({ ...e });
    }
    return { nodes: [...nodes.values()], edges: merged, start: state?.start ?? '' };
}

const DIRS = { north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0], northeast: [1, -1], northwest: [-1, -1], southeast: [1, 1], southwest: [-1, 1],
    n: [0, -1], s: [0, 1], e: [1, 0], w: [-1, 0], ne: [1, -1], nw: [-1, -1], se: [1, 1], sw: [-1, 1], up: [1, -1], down: [-1, 1], upstairs: [1, -1], downstairs: [-1, 1],
    out: [0, 1], outside: [0, 1], in: [0, -1], inside: [0, -1], back: [0, -1], front: [0, 1] };
/** Direction hint for an exit name (compass words, up/down, in/out); anything else (a door, "store", "gate") = no hint (null). */
export function dirVector(direction) {
    const d = lc(direction).trim();
    if (DIRS[d]) return DIRS[d];
    for (const w of d.split(/[^a-z]+/)) if (DIRS[w] && w.length > 2) return DIRS[w];
    return null;
}

// ---- Map layers: world (one node per region), region (one node per subregion), subregion (its rooms).
export const regionKey = id => `region:${id}`;
export const subregionKey = (region, sub) => `sub:${region}:${sub}`;
/** The layer showing a room: the subregion it is in. */
export function layerOf(graph, id) {
    const n = graph.nodes.find(x => x.id === id);
    return n && n.kind !== 'stub' ? { level: 'subregion', region: n.regionId, subregion: n.subregion.id } : { level: 'world' };
}
export const layerKey = l => l?.level === 'subregion' ? `${l.region}:${l.subregion}` : l?.level === 'region' ? `${l.region}:` : 'world';
/** Breadcrumb for a layer: [{label, layer}] from the world down. */
export function breadcrumb(graph, layer) {
    const out = [{ label: 'World', layer: { level: 'world' } }];
    if (!layer || layer.level === 'world') return out;
    const inReg = graph.nodes.find(n => n.kind !== 'stub' && n.regionId === layer.region);
    out.push({ label: inReg?.region || layer.region, layer: { level: 'region', region: layer.region } });
    if (layer.level === 'subregion') {
        const inSub = graph.nodes.find(n => n.kind !== 'stub' && n.regionId === layer.region && n.subregion.id === layer.subregion);
        out.push({ label: inSub?.subregion.name || layer.subregion, layer: { ...layer } });
    }
    return out;
}
const unit = v => { const d = v ? Math.hypot(v[0], v[1]) : 0; return d > 1e-9 ? [v[0] / d, v[1] / d] : null; };

/**
 * The graph for one layer, built only from the discovered graph (so the discovery rules carry over: nothing the
 * play graph doesn't hold can show up). Rooms are grouped into areas: subregions in a region layer, regions in the
 * world layer. Areas outside the layer that an exit links to directly become small 'outside' nodes. Unknown exits
 * (stubs) only show in the subregion layer, label only. Each edge gets `v`, its direction hint (or null).
 */
export function layerGraph(graph, layer = { level: 'world' }) {
    const level = layer?.level ?? 'world';
    const byId = new Map(graph.nodes.map(n => [n.id, n]));
    const inLayer = n => level === 'world' || (n.regionId === layer.region && (level === 'region' || n.subregion.id === layer.subregion));
    const sk = n => subregionKey(n.regionId, n.subregion.id), rk = n => regionKey(n.regionId);
    const keyOf = n => level === 'subregion' ? (inLayer(n) ? n.id : n.regionId === layer.region ? sk(n) : rk(n))
        : level === 'region' ? (inLayer(n) ? sk(n) : rk(n)) : rk(n);
    const nodes = new Map();
    const area = (n, outside) => {
        const k = keyOf(n), regionLevel = k.startsWith('region:');
        let a = nodes.get(k);
        if (!a) {
            const name = regionLevel ? (n.region || n.regionId) : n.regionId !== layer.region && level !== 'world' ? `${n.subregion.name}, ${n.region || n.regionId}` : n.subregion.name;
            a = { id: k, kind: outside ? 'outside' : 'seen', level: regionLevel ? 'region' : 'subregion', name: name || k, region: n.region, regionId: n.regionId,
                subregion: { id: k, name: name || k }, description: '', pos: null, here: false, rooms: [],
                layer: regionLevel ? { level: 'region', region: n.regionId } : { level: 'subregion', region: n.regionId, subregion: n.subregion.id } };
            nodes.set(k, a);
        }
        if (!outside) {
            a.rooms.push(n.id);
            if (n.kind === 'stood') a.kind = 'stood';
            if (n.here) a.here = true;
        } else if (n.here) a.here = true;
        return a;
    };
    for (const n of [...graph.nodes].sort((a, b) => a.id < b.id ? -1 : 1)) {
        if (n.kind === 'stub' || !inLayer(n)) continue;
        if (level === 'subregion') nodes.set(n.id, { ...n });
        else area(n, false);
    }
    const pairs = new Map(), edges = [];
    const one = (e, sign) => { const v = dirVector(e.direction); return v ? [v[0] * sign, v[1] * sign] : null; };
    for (const e of graph.edges) {
        const f = byId.get(e.from), t = byId.get(e.to);
        if (!f || !t) continue;
        if (t.kind === 'stub') { // unknown exit: label only, and only next to its own room
            if (level === 'subregion' && inLayer(f)) { nodes.set(t.id, { ...t }); edges.push({ ...e, v: unit(dirVector(e.direction)) }); }
            continue;
        }
        if (!inLayer(f) && !inLayer(t)) continue;
        if (level === 'subregion' && inLayer(f) && inLayer(t)) {
            edges.push({ ...e, v: unit(dirVector(e.direction) ?? (e.back && dirVector(e.back.direction) ? one(e.back, -1) : null)) });
            continue;
        }
        const a = inLayer(f) ? nodes.get(keyOf(f)) : area(f, true), b = inLayer(t) ? nodes.get(keyOf(t)) : area(t, true);
        if (!a || !b || a.id === b.id) continue;
        const [p, q] = a.id < b.id ? [a.id, b.id] : [b.id, a.id], sign = a.id === p ? 1 : -1;
        let agg = pairs.get(`${p}|${q}`);
        if (!agg) { agg = { from: p, to: q, dirs: [], closed: true, sum: [0, 0], dug: false }; pairs.set(`${p}|${q}`, agg); }
        for (const [x, s] of [[e, sign], ...(e.back ? [[e.back, -sign]] : [])]) {
            const v = one(x, s); if (v) { agg.sum[0] += v[0]; agg.sum[1] += v[1]; }
            const inside = level === 'subregion' ? (s === sign ? inLayer(f) : inLayer(t)) : false;
            if (inside && !agg.dirs.includes(x.direction)) agg.dirs.push(x.direction);
        }
        agg.closed = agg.closed && !!(e.closed && (!e.back || e.back.closed));
        agg.dug = agg.dug || !!e.dug;
    }
    for (const g of pairs.values()) edges.push({ from: g.from, to: g.to, direction: g.dirs.join(', '), closed: g.closed, dug: g.dug, description: '', v: unit(g.sum) });
    // Layout root = the layer's entrance: the subregion's entrance room; the region's entrance subregion; the
    // world's start region. layoutGraph falls back to the most connected node if it isn't discovered.
    const inside = graph.nodes.filter(n => n.kind !== 'stub' && inLayer(n));
    let root = '';
    if (level === 'subregion') root = inside.find(n => n.subEntrance)?.subEntrance ?? '';
    else if (level === 'region') { const e = inside.find(n => n.regionEntrance)?.regionEntrance; if (e) root = subregionKey(e.split(':')[0], e.split(':')[1].split('/')[0]); }
    else if (graph.start && String(graph.start).includes(':')) root = regionKey(String(graph.start).split(':')[0]);
    return { level, layer: level === 'world' ? { level } : { ...layer }, nodes: [...nodes.values()], edges, root };
}

/**
 * Organic layout (deterministic: same graph in, same positions out, whatever the input order).
 * Branches out from the root by connectivity, then relaxes with forces: linked nodes pull together to one link
 * length, all nodes push apart, compass exits (north, up, out...) nudge the direction of their link, other exits get
 * no nudge. Root: graph.root (the layer's entrance, see layerGraph) if it is in the graph, else the most connected one (ties: lowest id); it stays put. Rooms with
 * `pos` ({x, y} in link lengths) are pinned there. `prev` (id -> {x, y}) keeps already-placed nodes close to where
 * they were, so a new room doesn't reshuffle the map. Returns Map id -> {x, y} in pixels, no two nodes overlapping.
 */
export function layoutGraph(graph, { prev = null, L = 210, nodeW = 170, nodeH = 56, gap = 16, iterations = 300 } = {}) {
    const nodes = [...graph.nodes].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0), N = nodes.length;
    const idx = new Map(nodes.map((n, i) => [n.id, i]));
    const edges = graph.edges.map(e => ({ a: idx.get(e.from), b: idx.get(e.to), v: e.v !== undefined ? unit(e.v) : unit(dirVector(e.direction) ?? (e.back && dirVector(e.back.direction) ? dirVector(e.back.direction).map(c => -c) : null)) }))
        .filter(e => e.a !== undefined && e.b !== undefined && e.a !== e.b).sort((p, q) => p.a - q.a || p.b - q.b);
    const adj = nodes.map(() => []);
    for (const e of edges) { adj[e.a].push({ to: e.b, v: e.v }); adj[e.b].push({ to: e.a, v: e.v && [-e.v[0], -e.v[1]] }); }
    for (const l of adj) l.sort((p, q) => p.to - q.to);
    const x = new Float64Array(N), y = new Float64Array(N), placed = new Uint8Array(N), fixed = new Uint8Array(N);
    const pinned = i => nodes[i].pos && Number.isFinite(nodes[i].pos.x) && Number.isFinite(nodes[i].pos.y);
    const old = i => prev && (prev instanceof Map ? prev.get(nodes[i].id) : prev[nodes[i].id]);
    const put = (i, px, py) => { x[i] = px; y[i] = py; placed[i] = 1; };
    for (let i = 0; i < N; i++) if (pinned(i)) { put(i, nodes[i].pos.x * L, nodes[i].pos.y * L); fixed[i] = 1; }
    // Components, each with its root.
    const comp = new Int32Array(N).fill(-1), comps = [];
    for (let i = 0; i < N; i++) if (comp[i] < 0) {
        const members = [i]; comp[i] = comps.length;
        for (let k = 0; k < members.length; k++) for (const { to } of adj[members[k]]) if (comp[to] < 0) { comp[to] = comps.length; members.push(to); }
        comps.push(members);
    }
    const rank = i => [nodes[i].id === graph.root ? 1 : 0, adj[i].length];
    const better = (i, j) => { const [a, b] = [rank(i), rank(j)]; return a[0] !== b[0] ? a[0] > b[0] : a[1] !== b[1] ? a[1] > b[1] : i < j; };
    const roots = comps.map(m => m.reduce((r, i) => better(i, r) ? i : r, m[0]));
    const order = comps.map((m, c) => c).sort((c, d) => better(roots[c], roots[d]) ? -1 : 1);
    let right = -Infinity;
    order.forEach((c, k) => {
        const r = roots[c];
        if (!placed[r]) { const o = old(r); if (o) put(r, o.x, o.y); else put(r, k === 0 ? 0 : right + L * 1.5, 0); }
        if (k === 0) fixed[r] = 1;
        const parent = new Int32Array(N).fill(-1), queue = [r];
        const seen = new Set([r]);
        while (queue.length) {
            const p = queue.shift();
            const kids = adj[p].filter(({ to }) => !seen.has(to));
            const free = kids.filter(({ to, v }) => !placed[to] && !old(to) && !v);
            const base = parent[p] >= 0 ? Math.atan2(y[p] - y[parent[p]], x[p] - x[parent[p]]) : 0;
            const spread = parent[p] >= 0 ? Math.PI * 0.9 : Math.PI * 2;
            for (const { to, v } of kids) {
                seen.add(to); parent[to] = p; queue.push(to);
                if (placed[to]) continue;
                const o = old(to);
                if (o) { put(to, o.x, o.y); continue; }
                let d = v;
                if (!d) {
                    const i = free.findIndex(f => f.to === to), m = free.length;
                    const ang = parent[p] >= 0 ? base + (m > 1 ? (i / (m - 1) - 0.5) * spread : 0) : base + (i / m) * spread;
                    d = [Math.cos(ang), Math.sin(ang)];
                }
                put(to, x[p] + d[0] * L, y[p] + d[1] * L);
            }
        }
        for (const i of comps[c]) right = Math.max(right, x[i]);
    });
    // Relax.
    const ratio = nodeW / nodeH, fx = new Float64Array(N), fy = new Float64Array(N);
    for (let t = 0; t < iterations; t++) {
        const temp = L * 0.15 * (1 - t / iterations) + 0.5;
        fx.fill(0); fy.fill(0);
        for (let i = 0; i < N; i++) for (let j = i + 1; j < N; j++) {
            let dx = x[i] - x[j], dy = y[i] - y[j];
            if (Math.abs(dx) + Math.abs(dy) < 1e-6) { dx = (j - i) * 0.01; dy = (i % 3 - 1) * 0.01; }
            const d = Math.max(1, Math.hypot(dx, dy * ratio)), f = (L * L * 0.06) / (d * d);
            fx[i] += dx * f; fy[i] += dy * f; fx[j] -= dx * f; fy[j] -= dy * f;
        }
        for (const e of edges) {
            const dx = x[e.b] - x[e.a], dy = y[e.b] - y[e.a], d = Math.max(1, Math.hypot(dx, dy)), f = 0.12 * (d - L) / d;
            fx[e.a] += dx * f; fy[e.a] += dy * f; fx[e.b] -= dx * f; fy[e.b] -= dy * f;
            if (e.v) { // nudge the link toward its compass direction
                const tx = x[e.a] + e.v[0] * L - x[e.b], ty = y[e.a] + e.v[1] * L - y[e.b];
                fx[e.b] += tx * 0.04; fy[e.b] += ty * 0.04; fx[e.a] -= tx * 0.04; fy[e.a] -= ty * 0.04;
            }
        }
        for (let i = 0; i < N; i++) {
            const o = old(i);
            if (o) { fx[i] += (o.x - x[i]) * 0.05; fy[i] += (o.y - y[i]) * 0.05; }
            fx[i] -= x[i] * 0.002; fy[i] -= y[i] * 0.002;
        }
        for (let i = 0; i < N; i++) {
            if (fixed[i]) continue;
            const m = Math.hypot(fx[i], fy[i]);
            if (m > temp) { fx[i] *= temp / m; fy[i] *= temp / m; }
            x[i] += fx[i]; y[i] += fy[i];
        }
    }
    // Untangle: move each free leaf (one link) to the spot around its neighbour that crosses the fewest links.
    const segCross = (p1, p2, p3, p4) => {
        const c = (a, b, q) => (q[1] - a[1]) * (b[0] - a[0]) - (b[1] - a[1]) * (q[0] - a[0]);
        return Math.sign(c(p1, p2, p3)) * Math.sign(c(p1, p2, p4)) < 0 && Math.sign(c(p3, p4, p1)) * Math.sign(c(p3, p4, p2)) < 0;
    };
    const crossingsAt = (i, j, px, py) => { // links crossed by the link j-(px,py), ignoring links touching i or j
        let n = 0;
        for (const e of edges) {
            if (e.a === i || e.b === i || e.a === j || e.b === j) continue;
            if (segCross([x[j], y[j]], [px, py], [x[e.a], y[e.a]], [x[e.b], y[e.b]])) n++;
        }
        return n;
    };
    const overlapsAt = (i, px, py) => { let n = 0; for (let k = 0; k < N; k++) if (k !== i && Math.abs(x[k] - px) < nodeW + gap && Math.abs(y[k] - py) < nodeH + gap) n++; return n; };
    const crossedBy = (i, j) => { // links crossing the link i-j now, with all others fixed
        let n = 0;
        for (const e of edges) if (!(e.a === i || e.b === i || e.a === j || e.b === j) && segCross([x[i], y[i]], [x[j], y[j]], [x[e.a], y[e.a]], [x[e.b], y[e.b]])) n++;
        return n;
    };
    for (let round = 0; round < 2; round++) for (let i = 0; i < N; i++) {
        if (fixed[i] || old(i) || adj[i].length !== 1) continue;
        const { to: j, v } = adj[i][0];
        if (crossedBy(i, j) === 0 && overlapsAt(i, x[i], y[i]) === 0) continue;
        let best = null;
        for (let k = 0; k < 24; k++) {
            const ang = (k / 24) * Math.PI * 2, px = x[j] + Math.cos(ang) * L, py = y[j] + Math.sin(ang) * L;
            const dev = v ? 1 - (Math.cos(ang) * v[0] + Math.sin(ang) * v[1]) : 0;
            const score = crossingsAt(i, j, px, py) * 1000 + overlapsAt(i, px, py) * 300 + dev * 40 + Math.hypot(px - x[i], py - y[i]) / L;
            if (!best || score < best.score - 1e-9) best = { score, px, py };
        }
        x[i] = best.px; y[i] = best.py;
    }
    // No overlaps: push overlapping boxes apart along the shorter overlap.
    const W = nodeW + gap, H = nodeH + gap;
    for (let pass = 0; pass < 200; pass++) {
        let any = false;
        for (let i = 0; i < N; i++) for (let j = i + 1; j < N; j++) {
            const dx = x[j] - x[i], dy = y[j] - y[i], ox = W - Math.abs(dx), oy = H - Math.abs(dy);
            if (ox <= 0 || oy <= 0 || (fixed[i] && fixed[j])) continue;
            any = true;
            const wi = fixed[i] ? 0 : fixed[j] ? 1 : 0.5, wj = 1 - wi;
            if (ox < oy) { const s = (dx >= 0 ? 1 : -1) * (ox + 0.5); x[i] -= s * wi; x[j] += s * wj; }
            else { const s = (dy > 0 || (dy === 0 && i < j) ? 1 : -1) * (oy + 0.5); y[i] -= s * wi; y[j] += s * wj; }
        }
        if (!any) break;
    }
    return new Map(nodes.map((n, i) => [n.id, { x: Math.round(x[i] * 10) / 10, y: Math.round(y[i] * 10) / 10 }]));
}

/** How many pairs of links cross (fewer is a tidier map). */
export function crossings(graph, pos) {
    const segs = graph.edges.map(e => [pos.get(e.from), pos.get(e.to), e.from, e.to]).filter(s => s[0] && s[1]);
    const ccw = (a, b, c) => (c.y - a.y) * (b.x - a.x) - (b.y - a.y) * (c.x - a.x);
    let n = 0;
    for (let i = 0; i < segs.length; i++) for (let j = i + 1; j < segs.length; j++) {
        const [a, b, a1, b1] = segs[i], [c, d, c1, d1] = segs[j];
        if ([a1, b1].some(v => v === c1 || v === d1)) continue;
        if (Math.sign(ccw(a, b, c)) * Math.sign(ccw(a, b, d)) < 0 && Math.sign(ccw(c, d, a)) * Math.sign(ccw(c, d, b)) < 0) n++;
    }
    return n;
}

/** A stable colour hue (0-359) for a subregion id. */
export function hueFor(id) {
    let h = 0;
    for (const ch of String(id ?? '')) h = (h * 31 + ch.charCodeAt(0)) % 360;
    return h;
}
