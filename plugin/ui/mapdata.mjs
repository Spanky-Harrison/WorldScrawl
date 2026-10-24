// Pure helpers for the play-mode map: which rooms the chat knows, and where to draw them. No DOM; unit-tested in node.

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
export const isClosed = (e, open = []) => e?.view === 'closed' && !(e.door && open.includes(e.door));
const firstSentence = t => String(t ?? '').trim().split(/(?<=[.!?])\s/)[0].slice(0, 200);

/**
 * The play-mode graph. Only discovered places: rooms stood in (full detail and exits) and rooms seen
 * (name, area and a one-line summary; never their exits). An exit that does not reveal where it leads is a
 * stub node carrying only its label. state: {location, stood[], seen[], doors_open[]}; rooms: address -> known room.
 */
export function buildGraph(state, rooms) {
    const stood = new Set(state?.stood ?? []), nodes = new Map(), edges = [];
    if (state?.location) stood.add(state.location);
    const open = state?.doors_open ?? [];
    const sub = r => ({ id: r?.subregion?.id ?? '', name: r?.subregion?.name ?? '' });
    for (const a of stood) {
        const r = rooms.get(a);
        if (r) nodes.set(a, { id: a, kind: 'stood', name: r.name, subregion: sub(r), region: r.region?.name ?? '', description: r.description ?? '', pos: r.pos ?? null, here: a === state.location });
    }
    const addSeen = (a, name, s, summary = '') => {
        if (!a || nodes.has(a)) return;
        nodes.set(a, { id: a, kind: 'seen', name: name ?? a, subregion: { id: s?.id ?? '', name: s?.name ?? '' }, region: '', description: summary, pos: null, here: false });
    };
    for (const a of state?.seen ?? []) { const r = rooms.get(a); if (r) addSeen(a, r.name, r.subregion, firstSentence(r.description)); }
    for (const a of stood) {
        const r = rooms.get(a);
        if (!r) continue;
        for (const e of r.exits ?? []) {
            const closed = isClosed(e, open);
            if (revealsDestination(e) && e.to) {
                addSeen(e.to, e.to_name, e.to_subregion, '');
                edges.push({ from: a, to: e.to, direction: e.direction, closed, dug: !!e.dug, description: e.description ?? '' });
            } else { // unrevealed: label only, the destination stays unknown
                const id = `stub:${a}|${lc(e.direction)}`;
                nodes.set(id, { id, kind: 'stub', name: e.direction, subregion: { id: '', name: '' }, region: '', description: '', pos: null, here: false });
                edges.push({ from: a, to: id, direction: e.direction, closed, dug: false, description: e.description ?? '' });
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
    return { nodes: [...nodes.values()], edges: merged };
}

const DIRS = { north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0], northeast: [1, -1], northwest: [-1, -1], southeast: [1, 1], southwest: [-1, 1],
    n: [0, -1], s: [0, 1], e: [1, 0], w: [-1, 0], ne: [1, -1], nw: [-1, -1], se: [1, 1], sw: [-1, 1], up: [1, -1], down: [-1, 1], upstairs: [1, -1], downstairs: [-1, 1],
    out: [0, 1], outside: [0, 1], in: [0, -1], inside: [0, -1], back: [0, -1], front: [0, 1] };
/** Grid step for an exit direction (compass words, up/down, in/out; anything else = no preference). */
export function dirVector(direction) {
    const d = lc(direction).trim();
    if (DIRS[d]) return DIRS[d];
    for (const w of d.split(/[^a-z]+/)) if (DIRS[w] && w.length > 2) return DIRS[w];
    return null;
}

/**
 * Grid layout: rooms with a pos keep it; the rest are placed breadth-first from `center` one cell away in the
 * exit's direction (nearest free cell if taken). Returns Map id -> {x, y} in grid cells.
 */
export function layoutGraph(graph, center = null) {
    const pos = new Map(), used = new Set(), key = (x, y) => `${x},${y}`;
    const take = (id, x, y) => { pos.set(id, { x, y }); used.add(key(x, y)); };
    for (const n of graph.nodes) if (n.pos && Number.isFinite(n.pos.x) && Number.isFinite(n.pos.y)) take(n.id, n.pos.x, n.pos.y);
    const free = (x, y) => {
        if (!used.has(key(x, y))) return [x, y];
        for (let r = 1; r < 50; r++) for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
            if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
            if (!used.has(key(x + dx, y + dy))) return [x + dx, y + dy];
        }
        return [x, y + 50];
    };
    const adj = new Map(graph.nodes.map(n => [n.id, []]));
    for (const e of graph.edges) {
        adj.get(e.from)?.push({ to: e.to, v: dirVector(e.direction) });
        const bv = e.back ? dirVector(e.back.direction) : null, fv = dirVector(e.direction);
        adj.get(e.to)?.push({ to: e.from, v: bv ?? (fv ? [-fv[0], -fv[1]] : null) });
    }
    const order = graph.nodes.map(n => n.id);
    if (center && adj.has(center)) { order.splice(order.indexOf(center), 1); order.unshift(center); }
    let nextX = 0;
    for (const start of order) {
        if (!pos.has(start)) { const [x, y] = free(nextX, 0); take(start, x, y); }
        const queue = [start];
        while (queue.length) {
            const id = queue.shift(), p = pos.get(id);
            for (const { to, v } of adj.get(id) ?? []) {
                if (pos.has(to)) continue;
                const [x, y] = free(p.x + (v?.[0] ?? 1), p.y + (v?.[1] ?? 0));
                take(to, x, y); queue.push(to);
            }
        }
        nextX = Math.max(...[...pos.values()].map(q => q.x)) + 2;
    }
    return pos;
}

/** A stable colour hue (0-359) for a subregion id. */
export function hueFor(id) {
    let h = 0;
    for (const ch of String(id ?? '')) h = (h * 31 + ch.charCodeAt(0)) % 360;
    return h;
}
