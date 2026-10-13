import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { join } from 'node:path';

// Boots the real server and talks to it over HTTP. Every other server test
// covers a pure module; this one exists because the 401 path broke in
// production in a way no module-level test could see — a Response hoisted to a
// module constant answered the first request and 500'd every one after it,
// since sending a Response consumes its body stream (issue #299).
let proc: ReturnType<typeof Bun.spawn>;
let base: string;

beforeAll(async () => {
  proc = Bun.spawn(['bun', join(import.meta.dir, '../index.ts')], {
    // PORT=0 lets the OS pick a free port, so parallel runs can't collide.
    env: { ...process.env, PORT: '0' },
    stdout: 'pipe',
    stderr: 'inherit',
  });
  // The server logs its address once listening; that's our readiness signal.
  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let out = '';
  while (!/http:\/\/\S+?:(\d+)/.test(out)) {
    const { value, done } = await reader.read();
    if (done) throw new Error(`server exited before listening: ${out}`);
    out += decoder.decode(value);
  }
  base = `http://127.0.0.1:${out.match(/http:\/\/\S+?:(\d+)/)?.[1]}`;
});

afterAll(() => proc?.kill());

describe('media-token gated endpoints', () => {
  // The regression: these used to return 401 once, then 500 forever.
  for (const path of ['/api/turn-credentials', '/api/sfu/sessions/new']) {
    test(`${path} answers 401 on every request, not just the first`, async () => {
      for (let i = 1; i <= 3; i++) {
        const res = await fetch(base + path, { method: 'POST' });
        expect(`request ${i}: ${res.status}`).toBe(`request ${i}: 401`);
        expect(await res.json()).toEqual({
          errorCode: 'unauthorized',
          errorDescription: 'join required',
        });
      }
    });
  }

  test('an invalid token is rejected the same way as no token', async () => {
    const res = await fetch(`${base}/api/turn-credentials`, {
      headers: { 'x-engawa-token': 'not-a-real-token' },
    });
    expect(res.status).toBe(401);
  });
});

describe('public endpoints', () => {
  test('/api/health reports ok with the client count', async () => {
    const res = await fetch(`${base}/api/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, clients: 0 });
  });

  test('/api/config stays reachable across repeated calls', async () => {
    for (let i = 1; i <= 3; i++) {
      const res = await fetch(`${base}/api/config`);
      expect(`call ${i}: ${res.status}`).toBe(`call ${i}: 200`);
      expect(await res.json()).toEqual({ passwordRequired: false });
    }
  });
});
