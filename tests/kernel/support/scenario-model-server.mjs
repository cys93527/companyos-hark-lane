/**
 * STAGE 4 deterministic model seam — a scenario-scripted OpenAI-compatible SSE
 * endpoint (loopback, ZERO credentials). Each POST /v1/chat/completions serves
 * the NEXT scenario step:
 *
 *   { "tool_call": { "name": "write",  "arguments": { "file_path": "...", "content": "..." } } }
 *   { "tool_call": { "name": "pwsh",   "arguments": { "command": "..." } } }
 *   { "delay_ms": 30000 }                      // a hung invocation (cancel/timeout fixtures)
 *   { "text": "final answer" }                  // the terminal assistant message
 *
 * Env: PORT (default 8700), SCENARIO_FILE (JSON array), STATE_FILE (call counter).
 * This is the DETERMINISTIC protocol proof only — the real-agent proof runs
 * against a real model via the CompanyOS model profile.
 */
import http from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';

const PORT = Number(process.env.PORT ?? 8700);
const scenario = JSON.parse(readFileSync(process.env.SCENARIO_FILE, 'utf8'));
const stateFile = process.env.STATE_FILE;
let counter = 0;

const sse = (res, obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

const server = http.createServer((req, res) => {
  if (req.method !== 'POST' || !req.url?.includes('/chat/completions')) {
    res.writeHead(404).end('not found');
    return;
  }
  req.resume(); // consume the request body so 'end' fires (no data listener otherwise pauses the stream)
  req.on('end', () => {
    counter += 1;
    if (stateFile !== undefined) writeFileSync(stateFile, String(counter), 'utf8');
    const step = scenario[Math.min(counter - 1, scenario.length - 1)] ?? { text: '' };
    const id = `scenario-${counter}`;
    if (step.delay_ms !== undefined) {
      // Hold the response open without writing anything (a hung model invocation).
      setTimeout(() => { res.destroy(); }, Number(step.delay_ms));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    sse(res, { id, object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant' } }] });
    if (step.tool_call !== undefined) {
      sse(res, {
        id,
        object: 'chat.completion.chunk',
        choices: [{
          index: 0,
          delta: {
            tool_calls: [{
              index: 0,
              id: `call-${counter}`,
              type: 'function',
              function: {
                name: step.tool_call.name,
                arguments: JSON.stringify(step.tool_call.arguments ?? {}),
              },
            }],
          },
        }],
      });
      sse(res, { id, object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
    } else {
      sse(res, { id, object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: String(step.text ?? '') } }] });
      sse(res, { id, object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 9, completion_tokens: 3, total_tokens: 12 } });
    }
    res.write('data: [DONE]\n\n');
    res.end();
  });
});
server.listen(PORT, '127.0.0.1', () => console.log(`scenario-model-server on ${server.address().port} with ${scenario.length} steps`));
