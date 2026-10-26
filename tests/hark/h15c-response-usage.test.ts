/**
 * H15c — broker usage reading from real DeepSeek response framing (keep-alive comments,
 * usage:null chunks, final usage-only chunk, leading blank lines on non-streaming JSON).
 */
import { describe, expect, it } from 'vitest';
import { observeResponseUsage } from '../../apps/desktop/src/executor/embedded-dsh-runtime.js';

const SSE = 'text/event-stream; charset=utf-8';

describe('observeResponseUsage', () => {
  it('reads usage from a stream that opens with keep-alive comments (the live UNKNOWN cause)', () => {
    const body = ': keep-alive\n\n: keep-alive\n\ndata: {"choices":[{"delta":{"content":"a"}}],"usage":null}\n\ndata: {"choices":[],"usage":{"prompt_tokens":1200,"completion_tokens":80}}\n\ndata: [DONE]\n\n';
    const r = observeResponseUsage(body, SSE);
    expect(r.disposition).toBe('observed');
    expect(r.usage).toEqual({ inputTokens: 1200, outputTokens: 80, totalCost: null });
    expect(r.shape).toMatchObject({ framing: 'sse', commentLines: 2, dataEvents: 2, doneMarker: true, usageEvents: 1, nullUsageEvents: 1, unparsedEvents: 0 });
  });

  it('treats keep-alive comments between events as framing', () => {
    const body = 'data: {"choices":[],"usage":null}\n\n: keep-alive\n\ndata: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":6}}\n\ndata: [DONE]\n';
    expect(observeResponseUsage(body, SSE).disposition).toBe('observed');
  });

  it('recognises SSE by content type even when only comments arrived', () => {
    const r = observeResponseUsage(': keep-alive\n\n', SSE);
    expect(r.disposition).toBe('absent');
    expect(r.shape.framing).toBe('sse');
  });

  it('a stream without any usage chunk is absent (stays UNKNOWN)', () => {
    expect(observeResponseUsage('data: {"choices":[],"usage":null}\n\ndata: [DONE]\n', SSE).disposition).toBe('absent');
  });

  it('differing usage values are conflicting, never the last one', () => {
    const body = 'data: {"usage":{"prompt_tokens":3,"completion_tokens":2}}\n\ndata: {"usage":{"prompt_tokens":4,"completion_tokens":2}}\n\n';
    const r = observeResponseUsage(body, SSE);
    expect(r.disposition).toBe('conflicting');
    expect(r.usage).toBeNull();
  });

  it('a malformed usage object is invalid', () => {
    const r = observeResponseUsage('data: {"usage":{"prompt_tokens":-1,"completion_tokens":2}}\n\n', SSE);
    expect(r.disposition).toBe('invalid');
    expect(r.usage).toBeNull();
  });

  it('non-streaming JSON preceded by blank keep-alive lines', () => {
    const r = observeResponseUsage('\n\n\n{"choices":[],"usage":{"prompt_tokens":9,"completion_tokens":1}}', 'application/json');
    expect(r.disposition).toBe('observed');
    expect(r.shape.framing).toBe('json');
  });

  it('the shape never carries model text', () => {
    const r = observeResponseUsage('data: {"choices":[{"delta":{"content":"SECRET-ANSWER"}}],"usage":null}\n\n', SSE);
    expect(JSON.stringify(r.shape)).not.toContain('SECRET-ANSWER');
  });
});

describe('broker content coding (H15c-fix9, hark-live-goal 40296992054)', () => {
  it('decodes gzip, deflate and br bodies and refuses unknown codings', async () => {
    const { decodeResponseBody } = await import('../../apps/desktop/src/executor/embedded-dsh-runtime.js');
    const { gzipSync, deflateSync, brotliCompressSync } = await import('node:zlib');
    const text = 'data: {"usage":{"prompt_tokens":1,"completion_tokens":2}}\n\n';
    expect(decodeResponseBody(gzipSync(text), 'gzip')?.toString('utf8')).toBe(text);
    expect(decodeResponseBody(deflateSync(text), 'deflate')?.toString('utf8')).toBe(text);
    expect(decodeResponseBody(brotliCompressSync(text), 'br')?.toString('utf8')).toBe(text);
    expect(decodeResponseBody(Buffer.from(text), 'identity')?.toString('utf8')).toBe(text);
    expect(decodeResponseBody(Buffer.from(text), 'zstd')).toBeNull();
    expect(decodeResponseBody(Buffer.from('garbage'), 'gzip')).toBeNull();
  });
  it('restricts the forwarded Accept-Encoding to decodable codings', async () => {
    const { brokerAcceptEncoding } = await import('../../apps/desktop/src/executor/embedded-dsh-runtime.js');
    expect(brokerAcceptEncoding('gzip, deflate, br, zstd')).toBe('gzip, deflate, br');
    expect(brokerAcceptEncoding('zstd')).toBe('identity');
    expect(brokerAcceptEncoding(undefined)).toBe('identity');
    expect(brokerAcceptEncoding('br;q=0, gzip;q=0.5')).toBe('gzip;q=0.5');
  });
  it('records the coding in the shape', () => {
    expect(observeResponseUsage('data: [DONE]\n', SSE, 'gzip').shape.contentEncoding).toBe('gzip');
  });
});
