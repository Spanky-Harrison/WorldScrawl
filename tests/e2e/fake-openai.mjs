// Fake OpenAI-compatible server. Replies come from a queue: POST /__queue [{content} | {tool_calls:[{name, arguments}]} | {error} (a 500)]
// GET /__requests returns the received chat-completion bodies.
// POST /__mode {autoTracker: true} (the e2e run): the after-reply tracker ("bookkeeper") requests are answered on their
// own, from queued {kind: 'tracker'} items or else `{}`, never from the story queue, and /__requests leaves them out
// (?kind=tracker lists only them, ?kind=all lists every request in order). The prompt snapshot leaves it off.
import http from 'node:http';
const port = Number(process.argv[2] ?? 9098);
let queue = [], requests = [], trackerQueue = [], trackerRequests = [], all = [], autoTracker = false;
const isTracker = body => /You are the bookkeeper for a text adventure/.test(String((body.messages ?? []).find(m => m.role === 'system')?.content ?? ''));
const readBody = req => new Promise(r => { let d = ''; req.on('data', c => d += c); req.on('end', () => r(d)); });
http.createServer(async (req, res) => {
    const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (req.url === '/__mode' && req.method === 'POST') { autoTracker = !!JSON.parse(await readBody(req)).autoTracker; return json(200, { ok: true }); }
    if (req.url === '/__queue' && req.method === 'POST') {
        const items = JSON.parse(await readBody(req));
        queue = autoTracker ? items.filter(x => x?.kind !== 'tracker') : items;
        if (autoTracker) trackerQueue = items.filter(x => x?.kind === 'tracker');
        return json(200, { ok: true });
    }
    if (req.url?.startsWith('/__requests')) {
        const kind = new URL(req.url, 'http://x').searchParams.get('kind');
        return json(200, kind === 'tracker' ? trackerRequests : kind === 'all' ? all : requests);
    }
    if (req.url?.endsWith('/chat/completions') && req.method === 'POST') {
        const body = JSON.parse(await readBody(req));
        all.push(body);
        const tracker = autoTracker && isTracker(body);
        (tracker ? trackerRequests : requests).push(body);
        const next = tracker ? (trackerQueue.shift() ?? { content: '{}' }) : (queue.shift() ?? { content: 'ok' });
        if (next.delay) await new Promise(r => setTimeout(r, next.delay)); // {content, delay: ms}: a slow answer
        if (next.error) return json(500, { error: { message: next.error, type: 'server_error' } });
        const message = next.tool_calls
            ? { role: 'assistant', content: '', tool_calls: next.tool_calls.map((t, i) => ({ id: `call_${all.length}_${i}`, type: 'function', function: { name: t.name, arguments: JSON.stringify(t.arguments ?? {}) } })) }
            : { role: 'assistant', content: next.content };
        return json(200, { id: 'fake', object: 'chat.completion', created: 0, model: 'fake-model',
            choices: [{ index: 0, message, finish_reason: next.tool_calls ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
    }
    if (req.url?.endsWith('/models')) return json(200, { data: [{ id: 'fake-model' }] });
    json(404, { error: 'not found' });
}).listen(port, '127.0.0.1', () => console.log(`fake OpenAI on ${port}`));
