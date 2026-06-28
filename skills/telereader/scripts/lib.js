// Telereader skill — shared helpers (CommonJS so the extensionless executables
// run under any node `"type"` without a package.json). Pure, dependency-free,
// and built so the HTTP layer can be injected for fast deterministic tests.
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DEFAULT_BASE = 'https://telereader.ai';
const DEFAULT_CLIENT_ID = 'tlread';

function baseUrl(env = process.env) {
  return (env.TELEREADER_BASE_URL || DEFAULT_BASE).replace(/\/+$/, '');
}

function clientId(env = process.env) {
  return env.TELEREADER_CLIENT_ID || DEFAULT_CLIENT_ID;
}

function configDir(env = process.env) {
  const xdg = env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(xdg, 'telereader');
}

function tokenFile(env = process.env) {
  return path.join(configDir(env), 'token');
}

// Resolve the bearer token from the env or the 0600 token file. NEVER from argv
// (so it can't leak into `ps`).
function readToken(env = process.env) {
  if (env.TELEREADER_TOKEN) return env.TELEREADER_TOKEN.trim();
  const file = tokenFile(env);
  try {
    const t = fs.readFileSync(file, 'utf8').trim();
    return t || null;
  } catch {
    return null;
  }
}

function saveToken(token, env = process.env) {
  const dir = configDir(env);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = tokenFile(env);
  // Write with 0600 from the start (mode on open + an explicit chmod for the
  // case where the file pre-existed with looser bits).
  fs.writeFileSync(file, token, { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch { /* best effort */ }
  return file;
}

// An http(s) URL? Used to decide url-import vs literal-text submission.
function isHttpUrl(s) {
  if (typeof s !== 'string') return false;
  let u;
  try {
    u = new URL(s.trim());
  } catch {
    return false;
  }
  return u.protocol === 'http:' || u.protocol === 'https:';
}

// FAST empty-body check. The bash original used `${BODY//[[:space:]]/}`, a global
// substitution that span-locks the CPU for minutes on a ~27KB body under macOS
// bash 3.2. A regex test is O(n) and instant.
function isBlank(s) {
  return typeof s !== 'string' || /^\s*$/.test(s);
}

// Decide what `source` to submit from the positional arg + stdin.
//   - http(s):// URL  -> {kind:'url', url}      (Telereader fetches + cleans it)
//   - readable file   -> {kind:'markdown', body:<contents>}
//   - literal / stdin -> {kind:'markdown', body}
// `fileExists` is injectable for tests; defaults to a real fs check.
function resolveSource(arg, stdinBody, fileExists = (p) => {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}) {
  if (typeof arg === 'string' && arg !== '' && arg !== '-') {
    if (isHttpUrl(arg)) {
      return { kind: 'url', url: arg.trim() };
    }
    if (fileExists(arg)) {
      return { kind: 'markdown', body: fs.readFileSync(arg, 'utf8') };
    }
    return { kind: 'markdown', body: arg };
  }
  // No usable positional arg (missing or "-") -> stdin.
  return { kind: 'markdown', body: stdinBody == null ? '' : stdinBody };
}

// Build the request body. URL sources carry no body to blank-check.
function buildPayload(source, { title, voice } = {}) {
  const payload = { source };
  if (title) payload.title = title;
  if (voice) payload.voice = voice;
  return payload;
}

// Pull the request/trace ids out of response headers so a failure has something
// reportable. `headers` is a Headers (or anything with .get).
function traceIds(headers) {
  const get = (k) => {
    if (!headers) return null;
    if (typeof headers.get === 'function') return headers.get(k);
    return headers[k] || headers[k.toLowerCase()] || null;
  };
  const ids = {};
  const reqId = get('x-request-id') || get('x-trace-id');
  const cfRay = get('cf-ray');
  if (reqId) ids.requestId = reqId;
  if (cfRay) ids.cfRay = cfRay;
  return ids;
}

function formatTraceIds(ids) {
  const parts = [];
  if (ids.requestId) parts.push(`request-id=${ids.requestId}`);
  if (ids.cfRay) parts.push(`cf-ray=${ids.cfRay}`);
  return parts.join(' ');
}

// Submit a reading. Returns { readUrl, mode, raw, ids }. Throws a TelereaderError
// carrying status + ids on any non-2xx so the CLI can print a useful message.
async function submitReading({ source, title, voice }, opts = {}) {
  const env = opts.env || process.env;
  const fetchImpl = opts.fetch || fetch;
  const token = opts.token != null ? opts.token : readToken(env);
  if (!token) {
    throw new TelereaderError('not_onboarded', 0, {},
      'Not onboarded. Run the onboard script first.');
  }
  const payload = buildPayload(source, { title, voice });
  const res = await fetchImpl(`${baseUrl(env)}/api/v1/readings`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(payload),
  });

  const ids = traceIds(res.headers);
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* keep raw text */ }

  if (!res.ok) {
    const code = (data && data.error) || `http_${res.status}`;
    const msg = (data && data.message) || text || res.statusText;
    throw new TelereaderError(code, res.status, ids, msg, data);
  }

  const readUrl = data && data.readUrl;
  if (!readUrl) {
    throw new TelereaderError('no_read_url', res.status, ids,
      `unexpected response: ${text}`, data);
  }
  return { readUrl, mode: data.mode, raw: data, ids };
}

class TelereaderError extends Error {
  constructor(code, status, ids, message, data) {
    super(message || code);
    this.name = 'TelereaderError';
    this.code = code;
    this.status = status;
    this.ids = ids || {};
    this.data = data || null;
  }
}

module.exports = {
  DEFAULT_BASE,
  DEFAULT_CLIENT_ID,
  baseUrl,
  clientId,
  configDir,
  tokenFile,
  readToken,
  saveToken,
  isHttpUrl,
  isBlank,
  resolveSource,
  buildPayload,
  traceIds,
  formatTraceIds,
  submitReading,
  TelereaderError,
};
