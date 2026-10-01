// Starts `wrangler dev` against a fresh local D1 for integration tests.
//
// Every instance gets its own temporary persistence directory (so tests never share data),
// explicit secrets via --var, and a local mock server that stands in for Telegram, Twilio
// and the email API. Outbound calls are redirected to it with the *_API_BASE vars.

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const WORKER_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WRANGLER = join(WORKER_DIR, 'node_modules', '.bin', 'wrangler');
const QUIET_ENV = { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1', NO_COLOR: '1' };

export const SECRETS = {
  TOOL_SECRET: 'test-tool-secret', ADMIN_SECRET: 'test-admin-secret', ELEVENLABS_WEBHOOK_SECRET: 'test-webhook-secret',
  SESSION_SECRET: 'test-session-secret',
};

function run(args, { cwd = WORKER_DIR } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(WRANGLER, args, { cwd, env: QUIET_ENV, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', d => (out += d));
    p.stderr.on('data', d => (out += d));
    p.on('close', code => (code === 0 ? resolve(out) : reject(new Error(`wrangler ${args.join(' ')} failed:\n${out}`))));
  });
}

function freePort() {
  return new Promise(resolve => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

/**
 * Mock for every outbound API. `requests` collects what the Worker sent; `fail` makes a service return 500;
 * `routes` (functions `(req) => ({ status, body }) | undefined`) let a test answer like a real API.
 */
export async function startMock() {
  const mock = { requests: [], fail: new Set(), routes: [] };
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', d => (body += d));
    req.on('end', () => {
      const u = req.url;
      const service = u.includes('/sendMessage') ? 'telegram'
        : u.includes('/Messages.json') ? 'sms'
        : u.includes('/emails') ? 'email'
        : u.startsWith('/v1/convai') ? 'elevenlabs'
        : /PhoneNumbers/.test(u) ? 'twilio'
        : u.startsWith('/v1/') ? 'stripe' : 'other';
      let parsed = body;
      try { parsed = JSON.parse(body); } catch { parsed = Object.fromEntries(new URLSearchParams(body)); }
      const entry = { service, method: req.method, url: u, body: parsed, headers: req.headers, at: Date.now() };
      mock.requests.push(entry);
      if (mock.fail.has(service)) {
        res.writeHead(500, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ ok: false, error: 'mock failure' }));
      }
      for (const route of mock.routes) {
        const out = route(entry);
        if (out) {
          res.writeHead(out.status || 200, { 'content-type': 'application/json' });
          return res.end(JSON.stringify(out.body ?? {}));
        }
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, sid: 'SMmock', id: 'mock' }));
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  mock.url = `http://127.0.0.1:${server.address().port}`;
  mock.of = service => mock.requests.filter(r => r.service === service);
  mock.clear = () => { mock.requests.length = 0; };
  mock.close = () => new Promise(r => server.close(r));
  return mock;
}

/**
 * Start a Worker. Options:
 *   vars        extra vars/secrets (merged over SECRETS and the mock API bases)
 *   migrate     apply D1 migrations first (default true; false simulates a broken database)
 *   noDatabase  start with the D1 binding removed entirely
 *   varsFromMock (mockUrl) => vars, for settings that point at the mock (e.g. ELEVENLABS_API_BASE)
 */
export async function startDev({ vars = {}, varsFromMock = null, migrate = true, noDatabase = false } = {}) {
  const persist = mkdtempSync(join(tmpdir(), 'receptionist-d1-'));
  const mock = await startMock();
  let config = join(WORKER_DIR, 'wrangler.toml');
  if (noDatabase) {
    // Same config with the D1 binding removed: every query throws, like a dead binding in production.
    const { readFileSync } = await import('node:fs');
    const toml = readFileSync(config, 'utf8').replace(/\[\[d1_databases\]\][\s\S]*?(?=\n\[)/, '');
    config = join(WORKER_DIR, `.test-nodb-${process.pid}.wrangler.toml`);
    writeFileSync(config, toml);
  }
  if (migrate && !noDatabase) {
    await run(['d1', 'migrations', 'apply', 'receptionist', '--local', '--persist-to', persist, '--config', config]);
  }

  const port = await freePort();
  const allVars = {
    ...SECRETS,
    TELEGRAM_BOT_TOKEN: 'test-bot-token',
    TELEGRAM_API_BASE: mock.url,
    TWILIO_ACCOUNT_SID: 'ACtest',
    TWILIO_AUTH_TOKEN: 'test-twilio-token',
    TWILIO_FROM: '+447700900999',
    TWILIO_API_BASE: mock.url,
    RESEND_API_KEY: 'test-resend', EMAIL_FROM: 'Test <test@example.com>', EMAIL_API_BASE: mock.url,
    ELEVENLABS_API_KEY: 'test-xi', ELEVENLABS_API_BASE: mock.url,
    ...(varsFromMock ? varsFromMock(mock.url) : {}),
    ...vars,
  };
  const args = ['dev', '--config', config, '--ip', '127.0.0.1', '--port', String(port), '--persist-to', persist,
    '--test-scheduled', '--show-interactive-dev-session=false', '--log-level', 'log'];
  for (const [k, v] of Object.entries(allVars)) args.push('--var', `${k}:${v}`);
  const child = spawn(WRANGLER, args, { cwd: WORKER_DIR, env: QUIET_ENV, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', d => (log += d));
  child.stderr.on('data', d => (log += d));

  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 60_000;
  for (;;) {
    if (child.exitCode != null) throw new Error(`wrangler dev exited:\n${log}`);
    try { if ((await fetch(`${url}/`)).status) break; } catch { /* not up yet */ }
    if (Date.now() > deadline) { child.kill(); throw new Error(`wrangler dev did not start:\n${log}`); }
    await new Promise(r => setTimeout(r, 250));
  }

  const dev = {
    url, mock, persist,
    log: () => log,
    /** fetch with JSON helpers; `auth` is 'tool' | 'admin' | a raw header value */
    async call(method, path, { body, auth, headers = {} } = {}) {
      const h = { ...headers };
      if (auth === 'tool') h.authorization = `Bearer ${SECRETS.TOOL_SECRET}`;
      else if (auth === 'admin') h.authorization = `Bearer ${SECRETS.ADMIN_SECRET}`;
      else if (auth) h.authorization = auth;
      if (body !== undefined) h['content-type'] = 'application/json';
      const r = await fetch(url + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' });
      const text = await r.text();
      let data = text;
      try { data = JSON.parse(text); } catch { /* not json */ }
      return { status: r.status, data, headers: r.headers };
    },
    tool: (businessId, name, body) => dev.call('POST', `/b/${businessId}/${name}`, { body, auth: 'tool' }).then(r => r.data),
    admin: (method, path, body) => dev.call(method, path, { body, auth: 'admin' }),
    /** Trigger a cron handler, e.g. dev.cron('*\/5 * * * *'). */
    cron: expr => fetch(`${url}/__scheduled?cron=${encodeURIComponent(expr)}`).then(r => r.text()),
    /** Wait until fn() is truthy (for ctx.waitUntil side effects). */
    async until(fn, ms = 5000) {
      const end = Date.now() + ms;
      for (;;) {
        const v = await fn();
        if (v) return v;
        if (Date.now() > end) throw new Error('timed out waiting for condition');
        await new Promise(r => setTimeout(r, 50));
      }
    },
    async stop() {
      child.kill('SIGTERM');
      await new Promise(r => (child.exitCode != null ? r() : child.on('close', r)));
      await mock.close();
      rmSync(persist, { recursive: true, force: true });
      if (noDatabase) rmSync(config, { force: true });
    },
  };
  return dev;
}

/** Seed the example business (optionally under another id) and return its profile. */
export async function seedBusiness(dev, overrides = {}, agentId = null) {
  const { readFileSync } = await import('node:fs');
  const base = JSON.parse(readFileSync(join(WORKER_DIR, '..', 'prompts', 'business_profile.example.json'), 'utf8'));
  const profile = { ...base, ...overrides };
  const r = await dev.admin('PUT', '/admin/businesses', { agent_id: agentId, profile });
  if (r.status !== 200) throw new Error(`seed failed: ${JSON.stringify(r.data)}`);
  return profile;
}

/** Next date (YYYY-MM-DD, UK) after today that falls on the given weekday ('mon'...'sun'). */
export function nextWeekday(wd, from = new Date()) {
  const days = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(from);
  const [y, m, d] = today.split('-').map(Number);
  for (let i = 1; i <= 7; i++) {
    const dt = new Date(Date.UTC(y, m - 1, d + i));
    if (days[dt.getUTCDay()] === wd) return dt.toISOString().slice(0, 10);
  }
}
