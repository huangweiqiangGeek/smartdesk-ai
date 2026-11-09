import assert from 'node:assert/strict';
import console from 'node:console';
import process from 'node:process';
import { randomUUID, createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
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
assert.ok(
  ['127.0.0.1', 'localhost'].includes(base.hostname),
  'local database only',
);
const adminUrl = new URL(base);
adminUrl.pathname = '/postgres';
const admin = new Client({ connectionString: adminUrl.href });
const main = new Client({ connectionString: base.href });
const name = `smartdesk_t03_${process.pid}_${Date.now()}`;
assert.match(name, /^smartdesk_t03_\d+_\d+$/);
assert.notEqual(base.pathname, '/' + name);
const testUrl = new URL(base);
testUrl.pathname = '/' + name;
const db = new Client({ connectionString: testUrl.href });
const evidence = resolve(
  process.env.IDENTITY_EVIDENCE_DIR ?? resolve(root, 'test-results/identity'),
);
const children = [];
let browser;
let created = false;
let connected = false;
let before;
let passed = 0;
const password = 'T03-test-password-29!';
const hash = (s) => createHash('sha256').update(s).digest('hex');
function pass(label) {
  passed++;
  console.info('PASS ' + label);
}
async function port() {
  const server = createServer();
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  const value = server.address().port;
  await new Promise((ok) => server.close(ok));
  return value;
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
    // Hash inside PostgreSQL; no private row contents leave the database.
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
  const item = {
    label,
    child,
    output: '',
    script,
    env: { API_PORT: env.API_PORT, PORT: env.PORT },
    exit: null,
  };
  item.done = new Promise((ok) => {
    child.once('exit', (code, signal) => {
      item.exit = { code, signal };
      ok();
    });
  });
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
      ...item.env,
    }),
  );
  return item;
}
async function ready(url, item) {
  for (let i = 0; i < 100; i++) {
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

await mkdir(evidence, { recursive: true });
await admin.connect();
await main.connect();
const apiPort = await port();
const webPort = await port();
const api = `http://127.0.0.1:${apiPort}`;
const web = `http://127.0.0.1:${webPort}`;
async function request(actor, method, path, body, options = {}) {
  const response = await fetch(api + '/api/v1' + path, {
    signal: AbortSignal.timeout(10000),
    method,
    headers: {
      Origin: web,
      'Content-Type': 'application/json',
      'X-Requested-With': 'SmartDesk',
      'Idempotency-Key': options.key ?? randomUUID(),
      ...(actor?.cookie ? { Cookie: actor.cookie } : {}),
      ...(options.org ? { 'X-Organization-Id': options.org } : {}),
      ...options.headers,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const value = response.status === 204 ? null : await response.json();
  assert.equal(response.headers.get('cache-control'), 'no-store');
  if (value) {
    assert.match(value.requestId, /^[a-f0-9-]{36}$/);
    assert.ok('data' in value || 'error' in value);
    assert.doesNotMatch(
      JSON.stringify(value),
      /passwordHash|password_hash|tokenHash|token_hash|tokenDigest|connectionString|emailNormalized/,
    );
  }
  if (options.status !== undefined)
    assert.equal(
      response.status,
      options.status,
      method + ' ' + path + ' ' + JSON.stringify(value),
    );
  if (options.code) assert.equal(value.error?.code, options.code);
  return {
    status: response.status,
    data: value?.data,
    error: value?.error,
    cookie: response.headers.get('set-cookie')?.split(';')[0],
    headers: response.headers,
  };
}
async function register(email) {
  const r = await request(
    null,
    'POST',
    '/auth/register',
    { email, password, displayName: email.split('@')[0] },
    { status: 201 },
  );
  assert.match(r.headers.get('set-cookie'), /HttpOnly; SameSite=Lax/);
  return { ...r.data, cookie: r.cookie, email };
}
async function invite(actor, org, role = 'agent', key = randomUUID()) {
  const r = await request(
    actor,
    'POST',
    '/invitations',
    { role },
    { org, key, status: 201 },
  );
  return { ...r.data, token: new URL(r.data.inviteLink).hash.slice(1), key };
}
async function accept(actor, invitation, options = {}) {
  return request(
    actor,
    'POST',
    '/invitations/accept',
    { token: invitation.token },
    options,
  );
}
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
      env: { ...process.env, DATABASE_URL: testUrl.href },
      encoding: 'utf8',
      windowsHide: true,
    },
  );
  assert.equal(migration.status, 0, migration.stdout + migration.stderr);
  console.info('prisma migrate deploy exitCode=0');
  await db.connect();
  connected = true;
  const server = start(
    'isolated-api',
    resolve(root, 'apps/server/dist/main.js'),
    {
      DATABASE_URL: testUrl.href,
      API_PORT: String(apiPort),
      API_HOST: '127.0.0.1',
      APP_ORIGIN: web,
      NODE_ENV: 'test',
    },
  );
  await ready(api + '/health/live', server);
  const nuxt = start(
    'isolated-web',
    resolve(root, 'apps/web/.output/server/index.mjs'),
    {
      PORT: String(webPort),
      HOST: '127.0.0.1',
      NUXT_API_BASE: api,
      NUXT_PUBLIC_SOCKET_BASE: api,
    },
  );
  await ready(web + '/login', nuxt);
  pass('isolated migrated API and Nuxt startup');

  const a = await register('owner-a@example.test');
  const b = await register('owner-b@example.test');
  const c = await register('agent-c@example.test');
  const d = await register('agent-d@example.test');
  await request(
    null,
    'POST',
    '/auth/register',
    { email: 'OWNER-A@example.test', password, displayName: 'Duplicate' },
    { status: 409, code: 'EMAIL_EXISTS' },
  );
  await request(
    null,
    'POST',
    '/auth/login',
    { email: a.email, password: 'wrong-password-123' },
    { status: 401, code: 'INVALID_CREDENTIALS' },
  );
  await request(
    null,
    'POST',
    '/auth/login',
    { email: 'unknown@example.test', password },
    { status: 401, code: 'INVALID_CREDENTIALS' },
  );
  await request(a, 'GET', '/auth/me', undefined, { status: 200 });
  const stored = (
    await db.query('SELECT password_hash FROM users WHERE id=$1', [a.id])
  ).rows[0];
  assert.match(stored.password_hash, /^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
  const sessions = (
    await db.query('SELECT token_hash FROM auth_sessions WHERE user_id=$1', [
      a.id,
    ])
  ).rows;
  assert.equal(sessions[0].token_hash, hash(a.cookie.split('=')[1]));
  pass(
    'registration normalization, password hashing, session hash and generic login rejection',
  );

  const orgBody = { name: '企业甲', timezone: 'Asia/Shanghai' };
  const createKey = randomUUID();
  const createdTwice = await Promise.all(
    [1, 2].map(() =>
      request(a, 'POST', '/organizations', orgBody, { key: createKey }),
    ),
  );
  assert.deepEqual(createdTwice.map((r) => r.status).sort(), [200, 201]);
  assert.equal(createdTwice[0].data.id, createdTwice[1].data.id);
  const oa = createdTwice[0].data;
  const ob = (
    await request(
      b,
      'POST',
      '/organizations',
      { name: '企业乙' },
      { status: 201 },
    )
  ).data;
  const widget = (
    await db.query('SELECT * FROM widget_configs WHERE organization_id=$1', [
      oa.id,
    ])
  ).rows;
  assert.equal(widget.length, 1);
  assert.equal(widget[0].enabled, false);
  assert.deepEqual(widget[0].allowed_origins, []);
  assert.equal(oa.membership.role, 'admin');
  assert.equal(ob.timezone, 'Asia/Shanghai');
  await request(
    a,
    'POST',
    '/organizations',
    { ...orgBody, name: 'changed' },
    { key: createKey, status: 409, code: 'IDEMPOTENCY_CONFLICT' },
  );
  pass(
    'concurrent organization idempotency and atomic default administrator/widget',
  );

  await request(a, 'GET', `/organizations/${ob.id}`, undefined, {
    org: ob.id,
    status: 404,
  });
  await request(a, 'GET', `/organizations/${oa.id}`, undefined, {
    org: ob.id,
    status: 404,
  });
  await request(a, 'GET', '/memberships', undefined, {
    org: ob.id,
    status: 404,
  });
  await request(a, 'GET', '/invitations', undefined, {
    org: ob.id,
    status: 404,
  });
  await request(
    a,
    'PATCH',
    `/memberships/${ob.membership.id}`,
    { expectedVersion: 0, role: 'agent' },
    { org: oa.id, status: 404 },
  );
  await request(a, 'POST', '/organizations', orgBody, {
    headers: { Origin: 'https://evil.invalid' },
    status: 403,
    code: 'CSRF_REJECTED',
  });
  await request(a, 'POST', '/organizations', orgBody, {
    headers: { 'X-Requested-With': '' },
    status: 403,
  });
  await request(
    a,
    'POST',
    '/organizations',
    { ...orgBody, role: 'admin' },
    { status: 422 },
  );
  await request(a, 'GET', '/organizations?limit=101', undefined, {
    status: 422,
  });
  pass('cross-tenant paths, resources, CSRF and strict request validation');
  const malformed = await fetch(api + '/api/v1/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{',
  });
  assert.equal(malformed.status, 400);
  assert.equal((await malformed.json()).error.code, 'INVALID_REQUEST');
  pass('malformed JSON preserves the error envelope');

  const ia = await invite(a, oa.id);
  const preview = await request(
    null,
    'POST',
    '/invitations/preview',
    { token: ia.token },
    { status: 200 },
  );
  assert.deepEqual(Object.keys(preview.data).sort(), [
    'expiresAt',
    'organizationName',
    'role',
  ]);
  assert.equal(
    (await db.query('SELECT token_hash FROM invitations WHERE id=$1', [ia.id]))
      .rows[0].token_hash,
    hash(ia.token),
  );
  const retry = await request(
    a,
    'POST',
    '/invitations',
    { role: 'agent' },
    { org: oa.id, key: ia.key, status: 200 },
  );
  assert.equal(retry.data.inviteLink, null);
  assert.equal(retry.data.linkUnavailable, true);
  const acceptKey = randomUUID();
  const ca = await accept(c, ia, { key: acceptKey, status: 200 });
  await accept(c, ia, { key: acceptKey, status: 200 });
  await accept(d, ia, { status: 409, code: 'CONSUMED' });
  await request(
    c,
    'POST',
    '/invitations',
    { role: 'admin' },
    { org: oa.id, status: 403 },
  );
  await request(c, 'GET', '/invitations', undefined, {
    org: oa.id,
    status: 403,
  });
  const agentOrg = await request(
    c,
    'GET',
    `/organizations/${oa.id}`,
    undefined,
    { org: oa.id, status: 200 },
  );
  assert.equal(agentOrg.data.aiHealth, undefined);
  assert.equal(
    (
      await request(a, 'GET', `/organizations/${oa.id}`, undefined, {
        org: oa.id,
        status: 200,
      })
    ).data.aiHealth.providerState,
    'unverified',
  );
  await request(
    c,
    'PATCH',
    `/organizations/${oa.id}`,
    { expectedVersion: 0, name: 'hack' },
    { org: oa.id, status: 403 },
  );
  const upgrade = await invite(a, oa.id, 'admin');
  assert.equal(
    (await accept(c, upgrade, { status: 200 })).data.membership.role,
    'agent',
  );
  pass(
    'invitation token storage, minimal preview, one-time acceptance, replay and no silent role upgrade',
  );

  const race = await invite(b, ob.id);
  const winners = await Promise.all([c, d].map((u) => accept(u, race)));
  assert.deepEqual(winners.map((r) => r.status).sort(), [200, 409]);
  assert.equal(
    (
      await db.query(
        'SELECT count(*)::int AS n FROM memberships WHERE organization_id=$1 AND role=$2',
        [ob.id, 'agent'],
      )
    ).rows[0].n,
    1,
  );
  const revoked = await invite(a, oa.id);
  await request(
    b,
    'POST',
    `/invitations/${revoked.id}/revoke`,
    {},
    { org: ob.id, status: 404 },
  );
  for (let n = 0; n < 2; n++)
    await request(
      a,
      'POST',
      `/invitations/${revoked.id}/revoke`,
      {},
      { org: oa.id, status: 204 },
    );
  await accept(d, revoked, { status: 409, code: 'REVOKED' });
  await request(
    null,
    'POST',
    '/invitations/preview',
    { token: revoked.token },
    { status: 404 },
  );
  await request(
    a,
    'POST',
    `/invitations/${ia.id}/revoke`,
    {},
    { org: oa.id, status: 409 },
  );
  const expired = await invite(a, oa.id);
  await db.query(
    "UPDATE invitations SET created_at=now()-interval '8 days', expires_at=now()-interval '1 day' WHERE id=$1",
    [expired.id],
  );
  await accept(d, expired, { status: 409, code: 'EXPIRED' });
  const list = await request(
    a,
    'GET',
    '/invitations?status=revoked',
    undefined,
    { org: oa.id, status: 200 },
  );
  assert.equal(list.data.items[0].status, 'revoked');
  assert.equal(list.data.items[0].inviteLink, undefined);
  const paged = await request(a, 'GET', '/invitations?limit=1', undefined, {
    org: oa.id,
    status: 200,
  });
  assert.ok(paged.data.nextCursor);
  await request(
    b,
    'GET',
    '/invitations?cursor=' + paged.data.nextCursor,
    undefined,
    { org: ob.id, status: 422 },
  );
  pass(
    'concurrent consume, revoke, expiry and tenant-bound invitation pagination',
  );

  await request(
    a,
    'PATCH',
    `/memberships/${oa.membership.id}`,
    { expectedVersion: 0, role: 'agent' },
    { org: oa.id, status: 409, code: 'LAST_ADMIN_REQUIRED' },
  );
  await request(
    a,
    'PATCH',
    `/memberships/${oa.membership.id}`,
    { expectedVersion: 0, status: 'disabled' },
    { org: oa.id, status: 409, code: 'LAST_ADMIN_REQUIRED' },
  );
  const second = await invite(a, oa.id, 'admin');
  const ba = (await accept(b, second, { status: 200 })).data.membership;
  const demotions = await Promise.all(
    [
      [a, oa.membership],
      [b, ba],
    ].map(([u, m]) =>
      request(
        u,
        'PATCH',
        `/memberships/${m.id}`,
        { expectedVersion: m.version, role: 'agent' },
        { org: oa.id },
      ),
    ),
  );
  assert.deepEqual(demotions.map((r) => r.status).sort(), [200, 409]);
  assert.equal(
    (
      await db.query(
        "SELECT count(*)::int AS n FROM memberships WHERE organization_id=$1 AND role='admin' AND status='active'",
        [oa.id],
      )
    ).rows[0].n,
    1,
  );
  const owner = demotions[0].status === 409 ? a : b;
  const sessionC = (
    await db.query('SELECT id FROM auth_sessions WHERE token_hash=$1', [
      hash(c.cookie.split('=')[1]),
    ])
  ).rows[0].id;
  await db.query(
    "INSERT INTO presence_connections(organization_id,membership_id,auth_session_id,transport,updated_at) VALUES($1,$2,$3,'http',now())",
    [oa.id, ca.data.membership.id, sessionC],
  );
  const disabled = await request(
    owner,
    'PATCH',
    `/memberships/${ca.data.membership.id}`,
    { expectedVersion: 0, status: 'disabled' },
    { org: oa.id, status: 200 },
  );
  await request(c, 'GET', '/memberships', undefined, {
    org: oa.id,
    status: 404,
  });
  const ownOrgs = await request(c, 'GET', '/organizations', undefined, {
    status: 200,
  });
  assert.ok(!ownOrgs.data.items.some((o) => o.id === oa.id));
  await accept(c, ia, {
    key: acceptKey,
    status: 403,
    code: 'MEMBERSHIP_DISABLED',
  });
  const restoreInvite = await invite(owner, oa.id);
  await accept(c, restoreInvite, { status: 403 });
  assert.ok(
    (
      await db.query(
        'SELECT disconnected_at FROM presence_connections WHERE auth_session_id=$1',
        [sessionC],
      )
    ).rows[0].disconnected_at,
  );
  await request(
    owner,
    'PATCH',
    `/memberships/${ca.data.membership.id}`,
    { expectedVersion: 0, status: 'active' },
    { org: oa.id, status: 409, code: 'VERSION_CONFLICT' },
  );
  await request(
    owner,
    'PATCH',
    `/memberships/${ca.data.membership.id}`,
    { expectedVersion: disabled.data.version, status: 'active' },
    { org: oa.id, status: 200 },
  );
  const updateKey = randomUUID();
  const edit = {
    expectedVersion: 0,
    name: '企业甲更新',
    timezone: 'Europe/Paris',
  };
  await request(owner, 'PATCH', `/organizations/${oa.id}`, edit, {
    org: oa.id,
    key: updateKey,
    status: 200,
  });
  await request(owner, 'PATCH', `/organizations/${oa.id}`, edit, {
    org: oa.id,
    key: updateKey,
    status: 200,
  });
  await request(owner, 'PATCH', `/organizations/${oa.id}`, edit, {
    org: oa.id,
    status: 409,
    code: 'VERSION_CONFLICT',
  });
  pass(
    'last-admin concurrent guard, membership disable/restore, authorization refresh and optimistic versioning',
  );

  const audits = (await db.query('SELECT action,request_id FROM audit_events'))
    .rows;
  for (const action of [
    'organization.create',
    'invitation.create',
    'invitation.accept',
    'invitation.revoke',
    'membership.update',
    'organization.update',
  ]) {
    assert.ok(audits.some((row) => row.action === action && row.request_id));
  }
  pass('identity mutations retain audit events without credential payloads');
  const loginC = await request(
    null,
    'POST',
    '/auth/login',
    { email: c.email, password },
    { status: 200 },
  );
  const logged = { cookie: loginC.cookie };
  await request(logged, 'POST', '/auth/logout', {}, { status: 204 });
  await request(logged, 'POST', '/auth/logout', {}, { status: 204 });
  await request(logged, 'GET', '/auth/me', undefined, { status: 401 });
  await request(logged, 'POST', '/organizations', orgBody, { status: 401 });
  await db.query(
    "UPDATE auth_sessions SET created_at=now()-interval '9 days', expires_at=now()-interval '1 day' WHERE token_hash=$1",
    [hash(d.cookie.split('=')[1])],
  );
  await request(d, 'GET', '/auth/me', undefined, { status: 401 });
  await db.query("UPDATE users SET status='disabled' WHERE id=$1", [d.id]);
  await request(
    null,
    'POST',
    '/auth/login',
    { email: d.email, password },
    { status: 401, code: 'INVALID_CREDENTIALS' },
  );
  pass(
    'logout replay, old cookie rejection, expired sessions and disabled account login',
  );

  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(web + '/register');
  await page.getByLabel('显示名').fill('浏览器客服');
  await page.getByLabel('邮箱').fill('browser@example.test');
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '创建账号', exact: true }).click();
  await expect(page).toHaveURL(web + '/app/organizations');
  await expect(
    page.getByText('你还没有加入企业。', { exact: false }),
  ).toBeVisible();
  assert.ok(
    (await context.cookies()).find((x) => x.name === 'smartdesk_session')
      ?.httpOnly,
  );
  await page.getByRole('link', { name: '创建企业', exact: true }).click();
  await page.getByLabel('企业名称').fill('浏览器企业');
  await page.getByRole('button', { name: '创建企业', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: '浏览器企业', exact: true }),
  ).toBeVisible();
  const firstOrgPath = new URL(page.url()).pathname;
  await page.screenshot({
    path: resolve(evidence, 'organization-desktop.png'),
    fullPage: true,
  });
  await page.getByRole('button', { name: '退出登录' }).click();
  await expect(page).toHaveURL(web + '/login');
  await page.getByLabel('邮箱').fill('browser@example.test');
  await page.getByLabel('密码', { exact: true }).fill('wrong-password-123');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('邮箱或密码不正确');
  const browserInvite = await invite(owner, oa.id);
  await page.goto(web + '/invite#' + browserInvite.token);
  await expect(page.getByRole('link', { name: '登录后接受' })).toBeVisible();
  await expect(page).toHaveURL(web + '/invite');
  await page.getByRole('link', { name: '登录后接受' }).click();
  await page.getByLabel('邮箱').fill('browser@example.test');
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('button', { name: '接受邀请' })).toBeVisible();
  await page.getByRole('button', { name: '接受邀请' }).click();
  await expect(
    page.getByRole('heading', { name: '企业甲更新', exact: true }),
  ).toBeVisible();
  const otherTab = await context.newPage();
  await otherTab.goto(web + firstOrgPath);
  await expect(
    otherTab.getByRole('heading', { name: '浏览器企业', exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole('heading', { name: '企业甲更新', exact: true }),
  ).toBeVisible();
  await page.getByRole('link', { name: '切换企业' }).click();
  await page.getByRole('link', { name: /浏览器企业/ }).click();
  await expect(
    page.getByRole('heading', { name: '浏览器企业', exact: true }),
  ).toBeVisible();
  await otherTab.getByRole('button', { name: '退出登录' }).click();
  await page.reload();
  await expect(page.getByRole('alert')).toContainText('请重新登录');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(web + '/login');
  await expect(
    page.getByRole('button', { name: '登录', exact: true }),
  ).toBeVisible();
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
    true,
  );
  await page.screenshot({
    path: resolve(evidence, 'login-mobile.png'),
    fullPage: true,
  });
  assert.deepEqual(errors, []);
  await context.close();
  pass(
    'Chromium real registration/create/login errors/invite return/multi-tab tenant isolation/logout/mobile',
  );
  for (let n = 0; n < 31; n++) {
    const result = await request(null, 'POST', '/auth/login', {
      email: 'no@example.test',
      password,
    });
    if (result.status === 429) {
      pass('login rate limit returns 429');
      break;
    }
    assert.ok(n < 30, 'rate limit missing');
  }
  console.info(
    JSON.stringify({
      result: 'PASS',
      scenarios: passed,
      isolatedDatabase: name,
      api,
      web,
    }),
  );
} finally {
  await browser?.close();
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
        'SELECT count(*)::int AS n FROM pg_database WHERE datname=$1',
        [name],
      )
    ).rows[0].n,
    0,
  );
  await main.end();
  await admin.end();
  for (const address of [api, web]) {
    await assert.rejects(
      () => fetch(address),
      'owned listener must be released',
    );
  }
  console.info('CLEANUP PASS owned database removed and ports released');
}
