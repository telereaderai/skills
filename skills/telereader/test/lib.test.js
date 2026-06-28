'use strict';
// Fast, deterministic tests for the telereader skill helpers. Run with:
//   node --test skills/telereader/test/
// The HTTP layer is injected (no network), so these are sub-second and offline.

const test = require('node:test');
const assert = require('node:assert/strict');
const lib = require('../scripts/lib.js');

// --- URL vs text decision --------------------------------------------------

test('isHttpUrl: http(s) URLs are detected', () => {
  assert.equal(lib.isHttpUrl('https://example.com/article'), true);
  assert.equal(lib.isHttpUrl('http://example.com'), true);
  assert.equal(lib.isHttpUrl('  https://example.com/x  '), true); // trimmed
});

test('isHttpUrl: non-URLs and other schemes are NOT URLs', () => {
  assert.equal(lib.isHttpUrl('just some text'), false);
  assert.equal(lib.isHttpUrl('article.md'), false);
  assert.equal(lib.isHttpUrl('file:///etc/hosts'), false);
  assert.equal(lib.isHttpUrl('ftp://example.com'), false);
  assert.equal(lib.isHttpUrl(''), false);
  assert.equal(lib.isHttpUrl('Read https://example.com aloud'), false); // not a bare URL
});

test('resolveSource: a URL arg becomes a url source (no body)', () => {
  const src = lib.resolveSource('https://example.com/post', '', () => false);
  assert.deepEqual(src, { kind: 'url', url: 'https://example.com/post' });
});

test('resolveSource: a readable file becomes a markdown body', () => {
  // Inject a fileExists that says "yes" and stub fs read via a real temp file.
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const f = path.join(os.tmpdir(), `tlr-test-${process.pid}.md`);
  fs.writeFileSync(f, '# hi\n\nbody');
  try {
    const src = lib.resolveSource(f, '', (p) => p === f);
    assert.equal(src.kind, 'markdown');
    assert.equal(src.body, '# hi\n\nbody');
  } finally {
    fs.unlinkSync(f);
  }
});

test('resolveSource: literal text becomes a markdown body', () => {
  const src = lib.resolveSource('hello world', '', () => false);
  assert.deepEqual(src, { kind: 'markdown', body: 'hello world' });
});

test('resolveSource: "-" and missing arg read stdin', () => {
  assert.deepEqual(lib.resolveSource('-', 'piped text', () => false),
    { kind: 'markdown', body: 'piped text' });
  assert.deepEqual(lib.resolveSource(undefined, 'piped text', () => false),
    { kind: 'markdown', body: 'piped text' });
});

// --- the empty-body check that used to hang --------------------------------

test('isBlank: empty / whitespace-only is blank', () => {
  assert.equal(lib.isBlank(''), true);
  assert.equal(lib.isBlank('   \n\t  '), true);
  assert.equal(lib.isBlank(undefined), true);
});

test('isBlank: real text is not blank', () => {
  assert.equal(lib.isBlank('x'), false);
  assert.equal(lib.isBlank('  hello  '), false);
});

test('isBlank: a 27KB body is instant (no span-lock like bash ${//})', () => {
  // The bash original `${BODY//[[:space:]]/}` span-locked the CPU for minutes on
  // a body this size under macOS bash 3.2. This must complete in well under a
  // second. We assert both correctness and a generous time bound.
  const big = 'word '.repeat(27 * 1024 / 5); // ~27KB
  const t0 = Date.now();
  const blank = lib.isBlank(big);
  const dt = Date.now() - t0;
  assert.equal(blank, false);
  assert.ok(dt < 500, `isBlank on 27KB took ${dt}ms (expected < 500ms)`);

  // whitespace-only at the same size is also instant and correctly blank
  const bigWs = ' '.repeat(27 * 1024);
  const t1 = Date.now();
  const blank2 = lib.isBlank(bigWs);
  const dt1 = Date.now() - t1;
  assert.equal(blank2, true);
  assert.ok(dt1 < 500, `isBlank on 27KB whitespace took ${dt1}ms`);
});

// --- payload shape ---------------------------------------------------------

test('buildPayload: markdown body + title + voice', () => {
  const p = lib.buildPayload({ kind: 'markdown', body: 'hi' }, { title: 'T', voice: 'V' });
  assert.deepEqual(p, { source: { kind: 'markdown', body: 'hi' }, title: 'T', voice: 'V' });
});

test('buildPayload: url source omits empty title/voice', () => {
  const p = lib.buildPayload({ kind: 'url', url: 'https://x.com' }, {});
  assert.deepEqual(p, { source: { kind: 'url', url: 'https://x.com' } });
});

// --- header / trace-id capture ---------------------------------------------

test('traceIds: pulls x-request-id and cf-ray from a Headers object', () => {
  const h = new Headers({ 'x-request-id': 'req_123', 'cf-ray': 'ray_abc' });
  assert.deepEqual(lib.traceIds(h), { requestId: 'req_123', cfRay: 'ray_abc' });
});

test('traceIds: falls back to x-trace-id', () => {
  const h = new Headers({ 'x-trace-id': 'trace_9' });
  assert.deepEqual(lib.traceIds(h), { requestId: 'trace_9' });
});

test('formatTraceIds: renders a compact string', () => {
  assert.equal(lib.formatTraceIds({ requestId: 'r1', cfRay: 'c1' }), 'request-id=r1 cf-ray=c1');
  assert.equal(lib.formatTraceIds({}), '');
});

// --- submitReading: a fake fetch, no network -------------------------------

function fakeRes({ status = 200, body = {}, headers = {} } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: `HTTP ${status}`,
    headers: new Headers(headers),
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

test('submitReading: success returns readUrl + ids and sends a Bearer token', async () => {
  let seen = null;
  const fetchImpl = async (url, init) => {
    seen = { url, init };
    return fakeRes({
      status: 202,
      body: { mode: 'browser', readUrl: 'https://telereader.ai/r/abc' },
      headers: { 'x-request-id': 'req_777', 'cf-ray': 'ray_777' },
    });
  };
  const out = await lib.submitReading(
    { source: { kind: 'markdown', body: 'hi' } },
    { fetch: fetchImpl, token: 'TKN', env: {} },
  );
  assert.equal(out.readUrl, 'https://telereader.ai/r/abc');
  assert.equal(out.mode, 'browser');
  assert.deepEqual(out.ids, { requestId: 'req_777', cfRay: 'ray_777' });
  assert.equal(seen.url, 'https://telereader.ai/api/v1/readings');
  assert.equal(seen.init.headers.authorization, 'Bearer TKN');
  assert.deepEqual(JSON.parse(seen.init.body), { source: { kind: 'markdown', body: 'hi' } });
});

test('submitReading: a URL source is submitted as kind:url', async () => {
  let body = null;
  const fetchImpl = async (_url, init) => {
    body = JSON.parse(init.body);
    return fakeRes({ status: 202, body: { mode: 'browser', readUrl: 'https://telereader.ai/r/u' } });
  };
  const src = lib.resolveSource('https://example.com/post', '', () => false);
  await lib.submitReading({ source: src }, { fetch: fetchImpl, token: 'T', env: {} });
  assert.deepEqual(body.source, { kind: 'url', url: 'https://example.com/post' });
});

test('submitReading: 402 throws a TelereaderError carrying status + ids', async () => {
  const fetchImpl = async () => fakeRes({
    status: 402,
    body: { error: 'payment_required', message: 'URL import is a paid feature' },
    headers: { 'x-request-id': 'req_402' },
  });
  await assert.rejects(
    lib.submitReading({ source: { kind: 'url', url: 'https://x.com' } },
      { fetch: fetchImpl, token: 'T', env: {} }),
    (err) => {
      assert.equal(err.status, 402);
      assert.equal(err.code, 'payment_required');
      assert.equal(err.ids.requestId, 'req_402');
      return true;
    },
  );
});

test('submitReading: 5xx surfaces the trace id', async () => {
  const fetchImpl = async () => fakeRes({
    status: 503,
    body: { error: 'unavailable', message: 'try later' },
    headers: { 'cf-ray': 'ray_503' },
  });
  await assert.rejects(
    lib.submitReading({ source: { kind: 'markdown', body: 'x' } },
      { fetch: fetchImpl, token: 'T', env: {} }),
    (err) => {
      assert.equal(err.status, 503);
      assert.equal(err.ids.cfRay, 'ray_503');
      return true;
    },
  );
});

test('submitReading: missing token throws not_onboarded (no fetch call)', async () => {
  // Hermetic: point the config dir at an empty temp dir and clear the env token
  // so nothing on the host machine leaks in.
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const emptyCfg = fs.mkdtempSync(path.join(os.tmpdir(), 'tlr-empty-'));
  let called = false;
  const fetchImpl = async () => { called = true; return fakeRes(); };
  try {
    await assert.rejects(
      lib.submitReading({ source: { kind: 'markdown', body: 'x' } },
        { fetch: fetchImpl, env: { XDG_CONFIG_HOME: emptyCfg } }),
      (err) => err.code === 'not_onboarded',
    );
    assert.equal(called, false);
  } finally {
    fs.rmSync(emptyCfg, { recursive: true, force: true });
  }
});

// --- token storage round-trips at 0600 -------------------------------------

test('saveToken + readToken: round-trip with 0600 perms in a temp config dir', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tlr-cfg-'));
  const env = { XDG_CONFIG_HOME: dir };
  const file = lib.saveToken('secret-token', env);
  const mode = fs.statSync(file).mode & 0o777;
  assert.equal(mode, 0o600, `token file mode was ${mode.toString(8)}`);
  assert.equal(lib.readToken(env), 'secret-token');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('readToken: prefers $TELEREADER_TOKEN over the file', () => {
  assert.equal(lib.readToken({ TELEREADER_TOKEN: 'env-tok' }), 'env-tok');
});
