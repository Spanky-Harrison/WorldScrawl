// Fake OpenAI-compatible server. Replies come from a queue: POST /__queue [{content} | {tool_calls:[{name, arguments}]} | {error} (a 500)]
// GET /__requests returns the received chat-completion bodies.
import http from 'node:http';
const port = Number(process.argv[2] ?? 9098);
let queue = [], requests = [];
const readBody = req => new Promise(r => { let d = ''; req.on('data', c => d += c); req.on('end', () => r(d)); });
http.createServer(async (req, res) => {
    const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (req.url === '/__queue' && req.method === 'POST') { queue = JSON.parse(await readBody(req)); return json(200, { ok: true }); }
    if (req.url === '/__requests') return json(200, requests);
    if (req.url?.endsWith('/chat/completions') && req.method === 'POST') {
        const body = JSON.parse(await readBody(req));
        requests.push(body);
        const next = queue.shift() ?? { content: 'ok' };
        if (next.error) return json(500, { error: { message: next.error, type: 'server_error' } });
        const message = next.tool_calls
            ? { role: 'assistant', content: '', tool_calls: next.tool_calls.map((t, i) => ({ id: `call_${requests.length}_${i}`, type: 'function', function: { name: t.name, arguments: JSON.stringify(t.arguments ?? {}) } })) }
            : { role: 'assistant', content: next.content };
        return json(200, { id: 'fake', object: 'chat.completion', created: 0, model: 'fake-model',
            choices: [{ index: 0, message, finish_reason: next.tool_calls ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
    }
    if (req.url?.endsWith('/models')) return json(200, { data: [{ id: 'fake-model' }] });
    json(404, { error: 'not found' });
}).listen(port, '127.0.0.1', () => console.log(`fake OpenAI on ${port}`));
