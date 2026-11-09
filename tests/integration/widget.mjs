import assert from 'node:assert/strict';
import console from 'node:console';
import process from 'node:process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { createServer as tcpServer } from 'node:net';
import { createServer as httpsServer } from 'node:https';
import { request as httpRequest } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, URL } from 'node:url';
import { resolve } from 'node:path';
import { chromium, expect } from '@playwright/test';

const root = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(
  new URL('../../apps/server/package.json', import.meta.url),
);
const rootRequire = createRequire(
  new URL('../../package.json', import.meta.url),
);
rootRequire('dotenv').config({ path: resolve(root, '.env'), quiet: true });
const { Client } = require('pg');
const base = new URL(process.env.DATABASE_URL);
assert.ok(['localhost', '127.0.0.1'].includes(base.hostname));
const adminUrl = new URL(base);
adminUrl.pathname = '/postgres';
const admin = new Client({ connectionString: adminUrl.href });
const main = new Client({ connectionString: base.href });
const name = `smartdesk_t04_${process.pid}_${Date.now()}`;
assert.match(name, /^smartdesk_t04_\d+_\d+$/);
const dbUrl = new URL(base);
dbUrl.pathname = '/' + name;
assert.notEqual(dbUrl.pathname, base.pathname);
const db = new Client({ connectionString: dbUrl.href });
const chatAcceptance = process.env.WIDGET_CHAT_ACCEPTANCE === 'true';
const evidence = resolve(
  root,
  chatAcceptance ? 'test-results/visitor-chat' : 'test-results/widget',
);
const children = [];
let browser, tls, before;
let created = false,
  connected = false;
const checks = [];
const hash = (s) => createHash('sha256').update(s).digest('hex');
function pass(label) {
  checks.push(label);
  console.info('PASS ' + label);
}
async function port() {
  const s = tcpServer();
  await new Promise((ok) => s.listen(0, '127.0.0.1', ok));
  const n = s.address().port;
  await new Promise((ok) => s.close(ok));
  return n;
}
async function snapshot() {
  const tables = (
    await main.query(
      "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename",
    )
  ).rows;
  const result = {};
  for (const { tablename } of tables) {
    assert.match(tablename, /^[a-z_]+$/);
    result[tablename] = (
      await main.query(
        `SELECT count(*)::int AS count, md5(coalesce(string_agg(to_jsonb(t)::text, '' ORDER BY to_jsonb(t)::text), '')) AS digest FROM "${tablename}" t`,
      )
    ).rows[0];
  }
  return result;
}
function start(label, script, env) {
  const child = spawn(process.execPath, [script], {
    cwd: root,
    env: { ...process.env, ...env },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const item = { label, child, output: '', exit: null };
  item.done = new Promise((ok) =>
    child.once('exit', (code, signal) => {
      item.exit = { code, signal };
      ok();
    }),
  );
  child.stdout.on('data', (b) => {
    item.output += b;
  });
  child.stderr.on('data', (b) => {
    item.output += b;
  });
  children.push(item);
  console.info(
    JSON.stringify({
      start: label,
      command: `node ${script}`,
      cwd: root,
      pid: child.pid,
      port: env.PORT ?? env.API_PORT,
    }),
  );
  return item;
}
async function ready(url, item) {
  for (let i = 0; i < 450; i++) {
    if (item.exit) throw new Error(item.output);
    try {
      if ((await fetch(url, { signal: AbortSignal.timeout(2000) })).ok) return;
    } catch {
      /* startup */
    }
    await delay(200);
  }
  throw new Error('Startup timed out: ' + item.output);
}
const apiPort = await port(),
  webPort = await port(),
  tlsPort = await port();
const api = `http://127.0.0.1:${apiPort}`,
  web = `http://127.0.0.1:${webPort}`;
const widget = `https://widget.test:${tlsPort}`,
  siteA = `https://site-a.test:${tlsPort}`,
  siteB = `https://site-b.test:${tlsPort}`,
  blocked = `https://blocked.test:${tlsPort}`;
let publicKey, org, cookie;
async function request(method, path, body, options = {}) {
  const response = await fetch(api + '/api/v1' + path, {
    method,
    signal: AbortSignal.timeout(10000),
    headers: {
      Origin: options.origin ?? widget,
      'Content-Type': 'application/json',
      'Idempotency-Key': options.key ?? randomUUID(),
      'X-Requested-With': 'SmartDesk',
      ...(options.member ? { Cookie: cookie, 'X-Organization-Id': org } : {}),
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
      ...options.headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const value = response.status === 204 ? null : await response.json();
  if (options.status !== undefined)
    assert.equal(
      response.status,
      options.status,
      `${method} ${path}: ${value?.error?.code}`,
    );
  if (options.code) assert.equal(value?.error?.code, options.code);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  return {
    status: response.status,
    data: value?.data,
    error: value?.error,
    headers: response.headers,
  };
}
const boot = (body = {}, options = {}) =>
  request('POST', `/public/widgets/${publicKey}/bootstrap`, body, {
    origin: siteA,
    ...options,
  });
const patch = (token, customer, body, options = {}) =>
  request('PATCH', `/customers/${customer}`, body, { token, ...options });
async function configure(body, options = {}) {
  const current = await request('GET', '/widget-config', undefined, {
    member: true,
    status: 200,
  });
  return request(
    'PATCH',
    '/widget-config',
    { expectedVersion: current.data.version, ...body },
    { member: true, status: 200, ...options },
  );
}
const keyPath = resolve(evidence, `tls-${process.pid}.key`),
  certPath = resolve(evidence, `tls-${process.pid}.crt`);
await mkdir(evidence, { recursive: true });
await admin.connect();
await main.connect();
try {
  before = await snapshot();
  await writeFile(
    resolve(evidence, 'main-before.json'),
    JSON.stringify(before, null, 2),
  );
  await admin.query(`CREATE DATABASE "${name}"`);
  created = true;
  const migration = spawnSync(
    process.execPath,
    [rootRequire.resolve('prisma/build/index.js'), 'migrate', 'deploy'],
    {
      cwd: root,
      env: { ...process.env, DATABASE_URL: dbUrl.href },
      encoding: 'utf8',
      windowsHide: true,
    },
  );
  assert.equal(migration.status, 0, migration.stdout + migration.stderr);
  console.info('prisma migrate deploy exitCode=0');
  await db.connect();
  connected = true;
  const key = randomBytes(32).toString('base64');
  const apiEnv = {
    DATABASE_URL: dbUrl.href,
    API_PORT: String(apiPort),
    API_HOST: '127.0.0.1',
    APP_ORIGIN: widget,
    WIDGET_ORIGIN: widget,
    BOOTSTRAP_ACTIVE_KEY_ID: 'test-v1',
    BOOTSTRAP_RECEIPT_KEYS: JSON.stringify({ 'test-v1': key }),
    NODE_ENV: 'test',
  };
  let server = start(
    'isolated-api',
    resolve(root, 'apps/server/dist/main.js'),
    apiEnv,
  );
  await ready(api + '/health/live', server);
  const nuxt = start(
    'isolated-web',
    resolve(root, 'apps/web/.output/server/index.mjs'),
    {
      PORT: String(webPort),
      HOST: '127.0.0.1',
      NUXT_API_BASE: api,
      NUXT_PUBLIC_SOCKET_BASE: widget,
      NUXT_PUBLIC_WIDGET_ORIGIN: widget,
    },
  );
  await ready(web + '/login', nuxt);
  const owner = await request(
    'POST',
    '/auth/register',
    {
      email: 'widget-owner@example.test',
      password: 'T04-test-password-29!',
      displayName: 'Widget Owner',
    },
    { status: 201 },
  );
  cookie = owner.headers.get('set-cookie').split(';')[0];
  const organization = await request(
    'POST',
    '/organizations',
    { name: 'T04 isolated' },
    { headers: { Cookie: cookie }, status: 201 },
  );
  org = organization.data.id;
  const config = await request('GET', '/widget-config', undefined, {
    member: true,
    status: 200,
  });
  publicKey = config.data.publicKey;
  const agent = await request(
    'POST',
    '/auth/register',
    {
      email: 'widget-agent@example.test',
      password: 'T04-agent-password-29!',
      displayName: 'Agent',
    },
    { status: 201 },
  );
  const agentCookie = agent.headers.get('set-cookie').split(';')[0];
  const invite = await request(
    'POST',
    '/invitations',
    { role: 'agent' },
    { member: true, status: 201 },
  );
  await request(
    'POST',
    '/invitations/accept',
    { token: new URL(invite.data.inviteLink).hash.slice(1) },
    { headers: { Cookie: agentCookie }, status: 200 },
  );
  await request('GET', '/widget-config', undefined, {
    member: true,
    headers: { Cookie: agentCookie },
    status: 403,
  });
  await request(
    'PATCH',
    '/widget-config',
    { expectedVersion: 0, enabled: true },
    { member: true, headers: { Cookie: agentCookie }, status: 403 },
  );
  await request('GET', '/widget-config', undefined, {
    headers: { 'X-Organization-Id': org },
    status: 401,
  });
  await configure({
    enabled: true,
    allowedOrigins: [siteA, siteB],
    welcomeText: '您好，请问有什么可以帮您？',
  });
  await configure(
    { allowedOrigins: ['https://*.test'] },
    { status: 422, code: 'INVALID_ORIGIN' },
  );
  await configure({ welcomeText: 'x'.repeat(501) }, { status: 422 });
  await request(
    'PATCH',
    '/widget-config',
    { expectedVersion: 0, enabled: false },
    { member: true, status: 409, code: 'VERSION_CONFLICT' },
  );
  const pub = await request('GET', `/public/widgets/${publicKey}`, undefined, {
    origin: siteA,
    status: 200,
  });
  assert.equal(pub.headers.get('access-control-allow-origin'), siteA);
  assert.equal(pub.headers.get('access-control-allow-credentials'), null);
  assert.equal(pub.data.allowedOrigins, undefined);
  await boot({}, { origin: blocked, status: 403, code: 'ORIGIN_NOT_ALLOWED' });
  await request(
    'OPTIONS',
    `/public/widgets/${publicKey}/bootstrap`,
    undefined,
    { origin: blocked, status: 403 },
  );
  await request(
    'OPTIONS',
    `/public/widgets/${publicKey}/bootstrap`,
    undefined,
    { origin: siteA, status: 204 },
  );
  pass(
    'A018-A021 admin authorization, version, origin validation and exact CORS',
  );

  const command = randomUUID();
  const first = await boot({}, { key: command, status: 201 });
  const token = first.data.visitorToken,
    customer = first.data.customer.id;
  const concurrent = await Promise.all([
    boot({}, { key: command, status: 200 }),
    boot({}, { key: command, status: 200 }),
  ]);
  for (const r of concurrent) assert.deepEqual(r.data, first.data);
  const receipt = (
    await db.query('SELECT * FROM operation_receipts WHERE command_id=$1', [
      command,
    ])
  ).rows[0];
  assert.ok(receipt.response_ref.ciphertext);
  assert.equal(receipt.response_ref.keyId, 'test-v1');
  assert.ok(!JSON.stringify(receipt).includes(token));
  assert.ok(receipt.secret_expires_at - new Date() > 590000);
  const stored = (
    await db.query('SELECT * FROM visitor_sessions WHERE customer_id=$1', [
      customer,
    ])
  ).rows[0];
  assert.equal(stored.token_hash, hash(token));
  assert.ok(!JSON.stringify(stored).includes(token));
  await boot(
    { resumeToken: token },
    { key: command, status: 409, code: 'IDEMPOTENCY_CONFLICT' },
  );
  assert.equal(
    (await boot({ resumeToken: token }, { status: 200 })).data.customer.id,
    customer,
  );
  await boot({ resumeToken: token }, { origin: siteB, status: 401 });
  const secondOrg = await request(
    'POST',
    '/organizations',
    { name: 'Another widget' },
    { headers: { Cookie: cookie }, status: 201 },
  );
  const secondConfig = await request(
    'PATCH',
    '/widget-config',
    { expectedVersion: 0, enabled: true, allowedOrigins: [siteA] },
    {
      member: true,
      headers: { 'X-Organization-Id': secondOrg.data.id },
      status: 200,
    },
  );
  await request(
    'POST',
    `/public/widgets/${secondConfig.data.publicKey}/bootstrap`,
    { resumeToken: token },
    { origin: siteA, status: 401 },
  );
  await boot({ resumeToken: 'a'.repeat(64) }, { status: 401 });
  pass(
    'encrypted 10-minute receipts, concurrent same-key identity, hash-only sessions and site-bound resume',
  );

  const saveKey = randomUUID(),
    update = {
      expectedVersion: 0,
      name: '访客甲',
      email: 'Same@Example.test',
      preferredLanguage: 'en',
    };
  const saved = await patch(token, customer, update, {
    key: saveKey,
    status: 200,
  });
  assert.equal(saved.data.version, 1);
  assert.deepEqual(
    (await patch(token, customer, update, { key: saveKey, status: 200 })).data,
    saved.data,
  );
  await patch(token, customer, update, {
    status: 409,
    code: 'VERSION_CONFLICT',
  });
  await patch(
    token,
    customer,
    { expectedVersion: 1, internalNotes: 'no' },
    { status: 422 },
  );
  await patch(
    token,
    customer,
    { expectedVersion: 1, email: 'bad' },
    { status: 422 },
  );
  await patch(
    token,
    customer,
    { expectedVersion: 1, parentOrigin: siteB },
    { status: 422 },
  );
  await patch(undefined, customer, update, { member: true, status: 401 });
  await patch(token, customer, update, { origin: siteA, status: 403 });
  await request('GET', '/auth/me', undefined, { token, status: 401 });
  const stranger = await boot({}, { status: 201 });
  await patch(
    stranger.data.visitorToken,
    stranger.data.customer.id,
    { expectedVersion: 0, email: 'Same@Example.test' },
    { status: 200 },
  );
  assert.notEqual(stranger.data.customer.id, customer);
  await patch(
    stranger.data.visitorToken,
    customer,
    { expectedVersion: 1, name: '冒认' },
    { status: 404 },
  );
  // Seed actual private history in the isolated DB; no history endpoint is implemented in T04.
  await db.query(
    'INSERT INTO conversations (organization_id, customer_id, created_by_visitor_session_id, client_conversation_id, updated_at) VALUES ($1,$2,$3,$4,now())',
    [org, customer, stored.id, randomUUID()],
  );
  const strangerResume = await boot(
    { resumeToken: stranger.data.visitorToken },
    { status: 200 },
  );
  assert.equal(strangerResume.data.customer.id, stranger.data.customer.id);
  assert.equal(
    (
      await db.query(
        'SELECT count(*)::int n FROM conversations WHERE customer_id=$1',
        [strangerResume.data.customer.id],
      )
    ).rows[0].n,
    0,
  );
  assert.equal(
    (
      await db.query(
        'SELECT count(*)::int n FROM conversations WHERE customer_id=$1',
        [customer],
      )
    ).rows[0].n,
    1,
  );
  pass(
    'A024 version/idempotency, Cookie-Bearer separation and same-email identity cannot inherit seeded private history',
  );

  await configure({ allowedOrigins: [siteB] });
  await patch(token, customer, { expectedVersion: 1 }, { status: 403 });
  await configure({ allowedOrigins: [siteA, siteB], enabled: false });
  await patch(token, customer, { expectedVersion: 1 }, { status: 403 });
  await configure({ enabled: true });
  await db.query(
    "UPDATE visitor_sessions SET expires_at=now()-interval '1 second' WHERE id=$1",
    [stored.id],
  );
  const reset = await boot({ resumeToken: token }, { status: 201 });
  assert.equal(reset.data.identityReset, true);
  assert.notEqual(reset.data.customer.id, customer);
  await db.query(
    "UPDATE operation_receipts SET secret_expires_at=now()-interval '1 second' WHERE command_id=$1",
    [command],
  );
  await boot(
    {},
    { key: command, status: 409, code: 'BOOTSTRAP_RECEIPT_EXPIRED' },
  );
  assert.deepEqual(
    (
      await db.query(
        'SELECT response_ref FROM operation_receipts WHERE command_id=$1',
        [command],
      )
    ).rows[0].response_ref,
    { visitorSessionId: stored.id, expired: true },
  );
  pass(
    'config revocation/disable, explicit expired-token reset and committed expired-receipt tombstone',
  );

  const rotateCommand = randomUUID();
  const rotate = await boot({}, { key: rotateCommand, status: 201 });
  async function restart(keys, active) {
    server.child.kill();
    await server.done;
    server = start(
      `isolated-api-${children.length}`,
      resolve(root, 'apps/server/dist/main.js'),
      {
        ...apiEnv,
        BOOTSTRAP_RECEIPT_KEYS: JSON.stringify(keys),
        BOOTSTRAP_ACTIVE_KEY_ID: active,
      },
    );
    await ready(api + '/health/live', server);
  }
  const newKey = randomBytes(32).toString('base64');
  await restart({ 'test-v1': key, 'test-v2': newKey }, 'test-v2');
  assert.deepEqual(
    (await boot({}, { key: rotateCommand, status: 200 })).data,
    rotate.data,
  );
  await restart({ 'test-v2': newKey }, 'test-v2');
  await boot(
    {},
    { key: rotateCommand, status: 503, code: 'BOOTSTRAP_RECOVERY_UNAVAILABLE' },
  );
  await restart({}, '');
  await boot({}, { status: 503, code: 'BOOTSTRAP_UNAVAILABLE' });
  await restart({ 'test-v1': key, 'test-v2': newKey }, 'test-v2');
  await db.query(
    "UPDATE operation_receipts SET response_ref=jsonb_set(response_ref,'{tag}',to_jsonb('AAAAAAAAAAAAAAAAAAAAAA=='::text)) WHERE command_id=$1",
    [rotateCommand],
  );
  await boot(
    {},
    { key: rotateCommand, status: 503, code: 'BOOTSTRAP_RECOVERY_UNAVAILABLE' },
  );
  const sweepKey = randomUUID();
  await boot({}, { key: sweepKey, status: 201 });
  await db.query(
    "UPDATE operation_receipts SET secret_expires_at=now()-interval '1 second' WHERE command_id=$1",
    [sweepKey],
  );
  await expect
    .poll(
      async () =>
        (
          await db.query(
            'SELECT response_ref FROM operation_receipts WHERE command_id=$1',
            [sweepKey],
          )
        ).rows[0].response_ref.expired,
      { timeout: 35000, intervals: [1000] },
    )
    .toBe(true);
  pass(
    'live key rotation, removed/missing keys and tamper rejection; background ciphertext expiry cleanup',
  );

  const openssl =
    process.env.OPENSSL_PATH ?? 'C:/Program Files/Git/usr/bin/openssl.exe';
  const cert = spawnSync(
    openssl,
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      keyPath,
      '-out',
      certPath,
      '-days',
      '1',
      '-subj',
      '/CN=widget.test',
      '-addext',
      'subjectAltName=DNS:widget.test,DNS:site-a.test,DNS:site-b.test,DNS:blocked.test',
    ],
    { encoding: 'utf8', windowsHide: true },
  );
  assert.equal(cert.status, 0, cert.stderr);
  tls = httpsServer(
    { key: await readFile(keyPath), cert: await readFile(certPath) },
    (req, res) => {
      const host = req.headers.host?.split(':')[0];
      if (req.url.startsWith('/cookie-probe')) {
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ cookie: req.headers.cookie ?? '' }));
        return;
      }
      if (
        host !== 'widget.test' &&
        !req.url.startsWith('/demo/') &&
        !req.url.startsWith('/_nuxt/')
      ) {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        if (req.url.startsWith('/sender')) {
          res.end('<!doctype html><title>message sender</title>');
          return;
        }
        res.end(
          `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${host}</title><body><h1>${host}</h1><p>真实跨站接入验收</p><script src="${widget}/widget-loader.js" data-public-key="${publicKey}"></script></body></html>`,
        );
        return;
      }
      const upstream = httpRequest(
        (req.url.startsWith('/socket.io/') ? api : web) + req.url,
        { method: req.method, headers: req.headers },
        (response) => {
          res.writeHead(response.statusCode, response.headers);
          response.pipe(res);
        },
      );
      upstream.on('error', () => {
        res.statusCode = 502;
        res.end();
      });
      req.pipe(upstream);
    },
  );
  await new Promise((ok) => tls.listen(tlsPort, '127.0.0.1', ok));
  console.info(
    JSON.stringify({
      start: 'isolated-https-router',
      pid: process.pid,
      cwd: root,
      origins: [siteA, siteB, widget, blocked],
    }),
  );
  browser = await chromium.launch({
    args: ['--host-resolver-rules=MAP *.test 127.0.0.1', '--no-proxy-server'],
  });
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const customerRequests = [];
  page.on('request', (req) => {
    if (req.url().includes('/api/v1/customers/'))
      customerRequests.push(req.allHeaders());
  });
  await context.addCookies([
    {
      name: 'thirdparty_canary',
      value: 'present',
      url: widget,
      secure: true,
      sameSite: 'None',
    },
  ]);
  await page.goto(widget + '/cookie-probe');
  assert.match(await page.textContent('body'), /thirdparty_canary=present/);
  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.setCookieControls', {
    enableThirdPartyCookieRestriction: true,
  });
  await page.goto(siteA);
  const frame = page.frameLocator('iframe[title="SmartDesk 访客咨询"]');
  await expect(
    frame.getByText('访客身份已连接', { exact: true }),
  ).toBeVisible();
  const actual = page
    .frames()
    .find((f) => f.url().startsWith(widget + '/widget/'));
  const probe = await actual.evaluate(async () =>
    (await fetch('/cookie-probe', { credentials: 'include' })).json(),
  );
  assert.equal(
    probe.cookie,
    '',
    'browser must actually block a previously existing third-party cookie',
  );
  const storageKey = `smartdesk:visitor:${publicKey}:${siteA}`;
  const identity = async (p, origin) => {
    const state = await p.evaluate(
      (k) => JSON.parse(localStorage.getItem(k)),
      `smartdesk:visitor:${publicKey}:${origin}`,
    );
    const row = (
      await db.query(
        'SELECT id, customer_id FROM visitor_sessions WHERE token_hash=$1',
        [hash(state.token)],
      )
    ).rows[0];
    assert.ok(row);
    return row;
  };
  const a = await identity(page, siteA);
  await frame.getByLabel('姓名（选填）').fill('跨站甲');
  await frame.getByRole('button', { name: '保存资料', exact: true }).click();
  await expect(frame.getByText('资料已保存', { exact: true })).toBeVisible();
  await page.reload();
  await expect(frame.getByLabel('姓名（选填）')).toHaveValue('跨站甲');
  assert.equal((await identity(page, siteA)).customer_id, a.customer_id);
  await page.goto(siteB);
  await expect(
    frame.getByText('访客身份已连接', { exact: true }),
  ).toBeVisible();
  const b = await identity(page, siteB);
  assert.notEqual(a.customer_id, b.customer_id);
  await frame.getByLabel('姓名（选填）').fill('跨站乙');
  await frame.getByRole('button', { name: '保存资料', exact: true }).click();
  await expect(frame.getByText('资料已保存', { exact: true })).toBeVisible();
  await page.reload();
  await expect(frame.getByLabel('姓名（选填）')).toHaveValue('跨站乙');
  assert.equal((await identity(page, siteB)).customer_id, b.customer_id);
  await page.goto(siteA);
  await expect(frame.getByLabel('姓名（选填）')).toHaveValue('跨站甲');
  assert.deepEqual(await page.evaluate(() => Object.keys(localStorage)), [
    storageKey,
  ]);
  pass(
    'real HTTPS different-site A/B refresh recovery with third-party Cookie restriction proven by canary',
  );

  // An actual sibling window shares the expected parent origin but is not window.parent.
  const childUrl = new URL(
    page
      .frames()
      .find((f) => f.url().startsWith(widget + '/widget/'))
      .url(),
  );
  const spoof = {
    type: 'smartdesk:init',
    publicKey,
    channel: childUrl.searchParams.get('channel'),
    payload: {
      ...first.data,
      visitorToken: stranger.data.visitorToken,
      customer: { ...stranger.data.customer, name: 'SPOOFED' },
    },
    storageAvailable: true,
  };
  await page.evaluate((url) => {
    const el = document.createElement('iframe');
    el.id = 'sender';
    el.src = url;
    document.body.append(el);
  }, siteA + '/sender');
  await expect
    .poll(() => page.frames().some((f) => f.url() === siteA + '/sender'))
    .toBe(true);
  await page
    .frames()
    .find((f) => f.url() === siteA + '/sender')
    .evaluate(
      ({ data, origin }) => window.parent.frames[0].postMessage(data, origin),
      { data: spoof, origin: widget },
    );
  await delay(200);
  await expect(frame.getByLabel('姓名（选填）')).toHaveValue('跨站甲');
  // Wrong origin with real postMessage transport, then parent-side source rejection.
  await page.evaluate((url) => {
    document.querySelector('#sender').src = url;
  }, siteB + '/sender');
  await expect
    .poll(() => page.frames().some((f) => f.url() === siteB + '/sender'))
    .toBe(true);
  await page
    .frames()
    .find((f) => f.url() === siteB + '/sender')
    .evaluate(
      ({ data, origin }) => window.parent.frames[0].postMessage(data, origin),
      { data: spoof, origin: widget },
    );
  await page.evaluate(
    (data) =>
      window.postMessage(
        {
          type: 'smartdesk:refresh',
          publicKey: data.publicKey,
          channel: data.channel,
        },
        location.origin,
      ),
    spoof,
  );
  await delay(200);
  await expect(frame.getByLabel('姓名（选填）')).toHaveValue('跨站甲');
  assert.equal((await identity(page, siteA)).customer_id, a.customer_id);
  assert.ok(customerRequests.length >= 2);
  for (const headers of await Promise.all(customerRequests)) {
    assert.equal(headers.origin, widget);
    assert.equal(headers.cookie, undefined);
    assert.match(headers.authorization, /^Bearer [a-f0-9]{64}$/);
  }
  // Expected source (actual parent), wrong origin: isolates origin validation from source validation.
  const wrongParent = await context.newPage();
  await wrongParent.goto(siteB + '/sender');
  await wrongParent.evaluate((url) => {
    const el = document.createElement('iframe');
    el.src = url;
    document.body.append(el);
  }, childUrl.href);
  await expect(
    wrongParent.frameLocator('iframe').getByText('正在建立访客连接…'),
  ).toBeVisible();
  await wrongParent.evaluate(
    ({ data, origin }) => window.frames[0].postMessage(data, origin),
    { data: spoof, origin: widget },
  );
  await delay(200);
  await expect(
    wrongParent.frameLocator('iframe').getByText('正在建立访客连接…'),
  ).toBeVisible();
  await wrongParent.close();
  await page.evaluate(() => document.querySelector('#sender').remove());
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: resolve(evidence, 'cross-site-mobile.png'),
    fullPage: true,
  });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
    true,
  );
  pass(
    'real postMessage wrong-source and wrong-origin rejection; mobile iframe shell',
  );

  await page.goto(blocked);
  await expect(
    page.getByText('连接未完成，请重试。重试会保留本次请求。'),
  ).toBeVisible();
  assert.equal(page.frames().length, 1);
  pass('prohibited parent origin cannot load identity iframe');
  await context.close();

  const noStore = await browser.newContext({ ignoreHTTPSErrors: true });
  await noStore.addInitScript(() => {
    if (location.hostname === 'site-a.test') {
      Storage.prototype.getItem = () => {
        throw new Error('storage unavailable');
      };
      Storage.prototype.setItem = () => {
        throw new Error('storage unavailable');
      };
    }
  });
  const volatile = await noStore.newPage();
  await volatile.goto(siteA);
  const vf = volatile.frameLocator('iframe[title="SmartDesk 访客咨询"]');
  await expect(
    vf.getByText(
      '浏览器无法保存访客凭据。本页仍可使用，刷新或关闭后可能无法恢复。',
    ),
  ).toBeVisible();
  await vf.getByLabel('姓名（选填）').fill('临时访客');
  await vf.getByRole('button', { name: '保存资料', exact: true }).click();
  await expect(vf.getByText('资料已保存', { exact: true })).toBeVisible();
  await vf.getByRole('button', { name: '刷新资料' }).click();
  await expect(vf.getByLabel('姓名（选填）')).toHaveValue('临时访客');
  await noStore.close();
  pass(
    'unavailable first-party storage keeps current-page identity and visibly warns',
  );

  const lossContext = await browser.newContext({ ignoreHTTPSErrors: true });
  const loss = await lossContext.newPage();
  let lostKey, lostCustomer, injectionError;
  await loss.route('**/bootstrap', async (route) => {
    try {
      lostKey = route.request().headers()['idempotency-key'];
      const response = await route.fetch({
        url: api + new URL(route.request().url()).pathname,
      });
      lostCustomer = (await response.json()).data.customer.id;
      await route.abort('failed');
    } catch (error) {
      injectionError = error;
      await route.abort('failed');
    }
  });
  await loss.goto(siteA);
  await expect(loss.getByRole('button', { name: '重试连接' })).toBeVisible();
  assert.equal(injectionError, undefined);
  assert.equal(
    (
      await loss.evaluate(
        (k) => JSON.parse(localStorage.getItem(k)),
        storageKey,
      )
    ).pending.commandId,
    lostKey,
  );
  const countBefore = (await db.query('SELECT count(*)::int n FROM customers'))
    .rows[0].n;
  await loss.unroute('**/bootstrap');
  await loss.reload();
  await expect(
    loss.frameLocator('iframe').getByText('访客身份已连接', { exact: true }),
  ).toBeVisible();
  assert.equal((await identity(loss, siteA)).customer_id, lostCustomer);
  assert.equal(
    (await db.query('SELECT count(*)::int n FROM customers')).rows[0].n,
    countBefore,
  );
  pass(
    'server-committed bootstrap response loss survives full parent reload with identical command and customer',
  );
  await lossContext.close();

  const expiryContext = await browser.newContext({ ignoreHTTPSErrors: true });
  const expiry = await expiryContext.newPage();
  let expiredKey;
  await expiry.route('**/bootstrap', async (route) => {
    try {
      expiredKey = route.request().headers()['idempotency-key'];
      await route.fetch({ url: api + new URL(route.request().url()).pathname });
      await route.abort('failed');
    } catch (error) {
      injectionError = error;
      await route.abort('failed');
    }
  });
  await expiry.goto(siteA);
  await expect(expiry.getByRole('button', { name: '重试连接' })).toBeVisible();
  assert.equal(injectionError, undefined);
  await db.query(
    "UPDATE operation_receipts SET secret_expires_at=now()-interval '1 second' WHERE command_id=$1",
    [expiredKey],
  );
  const expiryCount = (await db.query('SELECT count(*)::int n FROM customers'))
    .rows[0].n;
  await expiry.unroute('**/bootstrap');
  await expiry.reload();
  await expect(
    expiry.getByRole('button', { name: '开始新的咨询身份' }),
  ).toBeVisible();
  assert.equal(
    (await db.query('SELECT count(*)::int n FROM customers')).rows[0].n,
    expiryCount,
  );
  await expiry.getByRole('button', { name: '开始新的咨询身份' }).click();
  await expect(
    expiry.frameLocator('iframe').getByText('访客身份已连接', { exact: true }),
  ).toBeVisible();
  assert.equal(
    (await db.query('SELECT count(*)::int n FROM customers')).rows[0].n,
    expiryCount + 1,
  );
  await expiryContext.close();
  assert.deepEqual(errors, []);
  pass(
    'expired lost bootstrap stays tombstoned until explicit new-identity action',
  );
  if (chatAcceptance) {
    const { verifyVisitorChat } = await import('./visitor-chat.mjs');
    await verifyVisitorChat({
      browser,
      request,
      db,
      siteA,
      siteB,
      widget,
      publicKey,
      configure,
      org,
      cookie,
      pass,
      evidence,
      api,
    });
  }
} finally {
  await browser?.close();
  if (tls) {
    tls.closeAllConnections();
    await new Promise((ok) => tls.close(ok));
  }
  for (const item of children.reverse()) {
    if (!item.exit) item.child.kill();
    await item.done;
    await writeFile(resolve(evidence, item.label + '.log'), item.output);
    console.info(
      JSON.stringify({
        stopped: item.label,
        pid: item.child.pid,
        exit: item.exit,
      }),
    );
  }
  if (connected) await db.end();
  if (created) await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
  if (before) {
    const after = await snapshot();
    await writeFile(
      resolve(evidence, 'main-after.json'),
      JSON.stringify(after, null, 2),
    );
    assert.deepEqual(after, before, 'main database changed');
    pass('main database every row digest unchanged');
  }
  assert.equal(
    (
      await admin.query(
        'SELECT count(*)::int n FROM pg_database WHERE datname=$1',
        [name],
      )
    ).rows[0].n,
    0,
  );
  await main.end();
  await admin.end();
  for (const address of [api, web])
    await assert.rejects(() => fetch(address), 'owned port must be released');
  const probePort = tcpServer();
  await new Promise((ok, reject) => {
    probePort.once('error', reject);
    probePort.listen(tlsPort, '127.0.0.1', ok);
  });
  await new Promise((ok) => probePort.close(ok));
  for (const file of [keyPath, certPath]) {
    assert.equal(
      resolve(file).startsWith(evidence + '\\') ||
        resolve(file).startsWith(evidence + '/'),
      true,
    );
    await unlink(file).catch((e) => {
      if (e.code !== 'ENOENT') throw e;
    });
  }
  await writeFile(
    resolve(evidence, 'result.json'),
    JSON.stringify(
      {
        checks,
        origins: [siteA, siteB, widget],
        cleanup: 'PASS',
        scenarios: checks.length,
      },
      null,
      2,
    ),
  );
  console.info(
    `CLEANUP PASS owned DB removed, ports released; ${checks.length} scenario groups passed`,
  );
}
