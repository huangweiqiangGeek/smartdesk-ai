import assert from 'node:assert/strict';
import console from 'node:console';
import process from 'node:process';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, URL } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(
  new URL('../../apps/server/package.json', import.meta.url),
);
require('dotenv').config({ path: resolve(root, '.env'), quiet: true });
const { Client } = require('pg');
const { io } = require('socket.io-client');
const { PrismaClient } = require(
  resolve(root, 'apps/server/dist/generated/prisma/client.js'),
);
const { PrismaPg } = require('@prisma/adapter-pg');
const { TaskPublisher } = require(
  resolve(root, 'apps/server/dist/modules/realtime/outbox.js'),
);
const base = new URL(process.env.DATABASE_URL);
assert.ok(['localhost', '127.0.0.1'].includes(base.hostname));
const name = `smartdesk_t11_${process.pid}_${Date.now()}`;
const container = `smartdesk-t11-${process.pid}-${Date.now()}`;
assert.match(name, /^smartdesk_t11_\d+_\d+$/);
const testUrl = new URL(base),
  adminUrl = new URL(base);
testUrl.pathname = '/' + name;
adminUrl.pathname = '/postgres';
assert.notEqual(testUrl.pathname, base.pathname);
const admin = new Client({ connectionString: adminUrl.href }),
  main = new Client({ connectionString: base.href }),
  db = new Client({ connectionString: testUrl.href });
const evidence = resolve(root, 'test-results/knowledge');
const results = [],
  sockets = [],
  children = [],
  calls = [];
let created = false,
  connected = false,
  redisStarted = false,
  before,
  prisma,
  publisher,
  api,
  second,
  disabled;
const origin = 'http://127.0.0.1:31999';
const pass = (label) => {
  results.push(label);
  console.info('PASS ' + label);
};
async function port() {
  const s = createServer();
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const p = s.address().port;
  await new Promise((r) => s.close(r));
  return p;
}
function docker(...args) {
  const r = spawnSync('docker', args, {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30000,
  });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  return r.stdout.trim();
}
async function until(f, label) {
  for (let i = 0; i < 150; i++) {
    if (await f()) return;
    await delay(100);
  }
  throw new Error('Timeout: ' + label);
}
async function snapshot() {
  const value = {};
  for (const { tablename } of (
    await main.query(
      "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename",
    )
  ).rows) {
    assert.match(tablename, /^[a-z_]+$/);
    value[tablename] = (
      await main.query(
        `SELECT count(*)::int count, md5(coalesce(string_agg(to_jsonb(t)::text,'' ORDER BY to_jsonb(t)::text),'')) digest FROM "${tablename}" t`,
      )
    ).rows[0];
  }
  return value;
}
async function start(mode = 'fake', outbox = false) {
  const url = `http://127.0.0.1:${await port()}`;
  const child = spawn(
    process.execPath,
    [resolve(root, 'apps/server/dist/main.js')],
    {
      cwd: root,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        DATABASE_URL: testUrl.href,
        API_PORT: new URL(url).port,
        APP_ORIGIN: origin,
        OUTBOX_ENABLED: String(outbox),
        AI_MODE: mode,
      },
    },
  );
  const item = {
    child,
    pid: child.pid,
    url,
    command: 'node apps/server/dist/main.js',
    cwd: root,
    output: '',
  };
  children.push(item);
  item.done = new Promise((r) =>
    child.on('exit', (code, signal) => {
      item.exit = { code, signal };
      r();
    }),
  );
  child.stdout.on('data', (b) => (item.output += b));
  child.stderr.on('data', (b) => (item.output += b));
  console.info(
    JSON.stringify({
      started: item.pid,
      url,
      command: item.command,
      cwd: root,
      mode,
    }),
  );
  await until(async () => {
    try {
      return (await fetch(url + '/health/live')).ok;
    } catch {
      return false;
    }
  }, 'API');
  return url;
}
async function request(a, method, path, body, status = 200, options = {}) {
  const response = await fetch((options.api ?? api) + '/api/v1' + path, {
    method,
    signal: AbortSignal.timeout(15000),
    headers: {
      Origin: origin,
      'Content-Type': 'application/json',
      'X-Requested-With': 'SmartDesk',
      'Idempotency-Key': options.key ?? randomUUID(),
      ...(a?.cookie ? { Cookie: a.cookie } : {}),
      ...(a?.org ? { 'X-Organization-Id': a.org } : {}),
      ...options.headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const value = response.status === 204 ? {} : await response.json();
  calls.push({
    method,
    path,
    status: response.status,
    requestId: value.requestId,
    error: value.error?.code,
  });
  assert.ok(
    (Array.isArray(status) ? status : [status]).includes(response.status),
    `${method} ${path}: ${response.status} ${JSON.stringify(value)}`,
  );
  assert.equal(response.headers.get('cache-control'), 'no-store');
  return {
    ...value,
    status: response.status,
    cookie: response.headers.get('set-cookie')?.split(';')[0],
  };
}
async function register(label) {
  const r = await request(
    null,
    'POST',
    '/auth/register',
    {
      email: `${label}@t11.invalid`,
      password: 'T11-password-long-123!',
      displayName: label,
    },
    201,
  );
  return { cookie: r.cookie, userId: r.data.id };
}
async function owner(label) {
  const a = await register(label);
  const o = (await request(a, 'POST', '/organizations', { name: label }, 201))
    .data;
  return { ...a, org: o.id, membershipId: o.membership.id };
}
const detail = async (a, d) =>
  (await request(a, 'GET', `/knowledge/${d.id}`)).data;
const create = async (a, type = 'faq', options = {}) =>
  (
    await request(
      a,
      'POST',
      '/knowledge',
      {
        type,
        titleOrQuestion: '  T11 合成资料  ',
        body: '  合成内容，不代表实际政策。  ',
      },
      201,
      options,
    )
  ).data;
const command = async (a, d, action, status = 200, extra = {}, options = {}) =>
  (
    await request(
      a,
      'POST',
      `/knowledge/${d.id}/${action}`,
      {
        ...(action === 'prepare' ? {} : { expectedVersion: d.version }),
        ...(['enable', 'prepare'].includes(action)
          ? { versionId: d.currentVersion.id }
          : {}),
        ...extra,
      },
      status,
      options,
    )
  ).data;
const revision = async (a) =>
  (
    await db.query('SELECT knowledge_revision FROM organizations WHERE id=$1', [
      a.org,
    ])
  ).rows[0].knowledge_revision;
const usable = async (a) =>
  (
    await db.query(
      "SELECT d.id FROM knowledge_documents d JOIN knowledge_versions v ON v.id=d.current_version_id AND v.organization_id=d.organization_id WHERE d.organization_id=$1 AND d.status='enabled' AND d.deleted_at IS NULL AND v.preparation_status='ready'",
      [a.org],
    )
  ).rows.map((r) => r.id);
// This fixture verifies business state only; no model or embedding execution is claimed.
async function readyFixture(d) {
  await db.query(
    "UPDATE knowledge_versions SET preparation_status='ready', prepared_at=clock_timestamp() WHERE id=$1",
    [d.currentVersion.id],
  );
}

try {
  await mkdir(evidence, { recursive: true });
  await admin.connect();
  await main.connect();
  before = await snapshot();
  await writeFile(
    resolve(evidence, 'main-before.json'),
    JSON.stringify(before, null, 2),
  );
  await admin.query(`CREATE DATABASE "${name}"`);
  created = true;
  const migration = spawnSync(
    process.execPath,
    [resolve(root, 'node_modules/prisma/build/index.js'), 'migrate', 'deploy'],
    {
      cwd: root,
      env: { ...process.env, DATABASE_URL: testUrl.href },
      windowsHide: true,
      encoding: 'utf8',
    },
  );
  await writeFile(
    resolve(evidence, 'migration.log'),
    migration.stdout + migration.stderr,
  );
  assert.equal(migration.status, 0);
  await db.connect();
  connected = true;
  const redisPort = await port(),
    image = (await readFile(resolve(root, 'compose.yaml'), 'utf8')).match(
      /image: (redis:[^\r\n]+)/,
    )[1];
  docker(
    'run',
    '-d',
    '--name',
    container,
    '-p',
    `127.0.0.1:${redisPort}:6379`,
    image,
  );
  redisStarted = true;
  process.env.REDIS_URL = `redis://127.0.0.1:${redisPort}`;
  prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: testUrl.href }),
  });
  publisher = new TaskPublisher(prisma);
  api = await start();
  second = await start();
  disabled = await start('disabled');
  const a = await owner('T11A'),
    b = await owner('T11B'),
    agent = await register('T11agent');
  const invitation = (
    await request(a, 'POST', '/invitations', { role: 'agent' }, 201)
  ).data;
  const joined = (
    await request(agent, 'POST', '/invitations/accept', {
      token: new URL(invitation.inviteLink).hash.slice(1),
    })
  ).data;
  Object.assign(agent, { org: a.org, membershipId: joined.membership.id });
  let faq = await create(a),
    doc = await create(a, 'text');
  assert.equal(faq.currentVersion.titleOrQuestion, 'T11 合成资料');
  assert.equal(faq.currentVersion.preparationStatus, 'not_started');
  assert.equal(faq.status, 'draft');
  const list = (await request(a, 'GET', '/knowledge')).data;
  assert.equal(list.items.length, 2);
  assert.ok(!('body' in list.items[0].currentVersion));
  const key = randomUUID(),
    body = { type: 'faq', titleOrQuestion: '幂等', body: '同一请求' };
  const first = (await request(a, 'POST', '/knowledge', body, 201, { key }))
    .data;
  assert.equal(
    (await request(a, 'POST', '/knowledge', body, 200, { key, api: second }))
      .data.id,
    first.id,
  );
  assert.equal(
    (
      await request(
        a,
        'POST',
        '/knowledge',
        { ...body, body: '不同内容' },
        409,
        { key },
      )
    ).error.code,
    'IDEMPOTENCY_CONFLICT',
  );
  assert.equal(
    (
      await db.query(
        "SELECT count(*)::int n FROM audit_events WHERE resource_id=$1 AND action='knowledge.create'",
        [first.id],
      )
    ).rows[0].n,
    1,
  );
  pass('FAQ/文本真实创建、摘要/详情、跨进程同键重放和审计一次');

  for (const bad of [
    { ...body, body: '  ' },
    { ...body, titleOrQuestion: '😀'.repeat(201) },
    { ...body, body: '😀'.repeat(8001) },
    { ...body, type: 'url' },
    { ...body, status: 'enabled' },
  ])
    await request(a, 'POST', '/knowledge', bad, 422);
  await request(
    a,
    'POST',
    '/knowledge',
    { ...body, titleOrQuestion: '😀'.repeat(200), body: '😀'.repeat(8000) },
    201,
  );
  await request(
    a,
    'POST',
    '/knowledge',
    { ...body, type: 'text', body: '😀'.repeat(50000) },
    201,
  );
  await request(
    a,
    'POST',
    '/knowledge',
    { ...body, type: 'text', body: 'a'.repeat(50001) },
    422,
  );
  for (const query of ['limit=101', 'limit=0', 'cursor=invalid', 'type=pdf'])
    await request(a, 'GET', '/knowledge?' + query, undefined, 422);
  const p = (await request(a, 'GET', '/knowledge?limit=1')).data;
  const p2 = (
    await request(a, 'GET', '/knowledge?limit=1&cursor=' + p.nextCursor)
  ).data;
  assert.notEqual(p.items[0].id, p2.items[0].id);
  await request(b, 'GET', '/knowledge?cursor=' + p.nextCursor, undefined, 422);
  await request(
    a,
    'GET',
    '/knowledge?q=other&cursor=' + p.nextCursor,
    undefined,
    422,
  );
  pass('code point上限、空白/未知字段拒绝、分页和游标绑定组织及筛选');

  await request(agent, 'POST', '/knowledge', body, 403);
  await request(agent, 'GET', '/knowledge/' + faq.id, undefined, 404);
  assert.equal(
    (await request(agent, 'GET', '/knowledge')).data.items.length,
    0,
  );
  await request(agent, 'GET', '/knowledge?status=draft', undefined, 403);
  await request(b, 'GET', '/knowledge/' + faq.id, undefined, 404);
  await request(
    b,
    'PATCH',
    '/knowledge/' + faq.id,
    { expectedVersion: 0, titleOrQuestion: 'cross', body: 'cross' },
    404,
  );
  await request({ ...a, org: b.org }, 'GET', '/knowledge', undefined, 404);
  await request({ org: a.org }, 'GET', '/knowledge', undefined, 401);
  await request(a, 'GET', '/knowledge', undefined, 403, {
    headers: { Authorization: 'Bearer visitor-token' },
  });
  await request(a, 'POST', '/knowledge', body, 403, {
    headers: { Origin: 'https://forbidden.test' },
  });
  await request(a, 'POST', '/knowledge', body, 403, {
    headers: { 'X-Requested-With': '' },
  });
  pass('admin/agent/未认证/访客、跨租户和CSRF负例');

  await command(a, faq, 'enable', 409);
  const prepKey = randomUUID();
  const requested = await command(a, faq, 'prepare', 202, {}, { key: prepKey });
  assert.equal(requested.preparationStatus, 'not_started');
  assert.equal(requested.preparationRequested, true);
  await Promise.all([
    command(a, faq, 'prepare', 202),
    command(a, faq, 'prepare', 202, {}, { key: prepKey, api: second }),
  ]);
  const event = await prisma.outboxEvent.findFirstOrThrow({
    where: {
      aggregateId: faq.currentVersion.id,
      eventType: 'knowledge.prepare.requested',
    },
  });
  assert.equal(
    await prisma.outboxEvent.count({
      where: { aggregateId: faq.currentVersion.id, destination: 'queue' },
    }),
    1,
  );
  await publisher.publish(event);
  await publisher.publish(event);
  const job = await publisher.queue.getJob(`${faq.currentVersion.id}-1`);
  assert.deepEqual(job.data, { versionId: faq.currentVersion.id });
  assert.equal(await job.getState(), 'waiting');
  assert.equal(
    (
      await db.query(
        'SELECT preparation_attempt, preparation_started_at FROM knowledge_versions WHERE id=$1',
        [faq.currentVersion.id],
      )
    ).rows[0].preparation_attempt,
    1,
  );
  pass(
    'prepare仅真实请求排队、重复点击同尝试、Redis ID-only job去重且未伪造ready',
  );

  await db.query(
    "UPDATE knowledge_versions SET preparation_status='failed', last_error_code='AI_UNAVAILABLE' WHERE id=$1",
    [faq.currentVersion.id],
  );
  await command(a, faq, 'prepare', 202, {}, { key: prepKey });
  assert.equal(
    (await detail(a, faq)).currentVersion.preparationStatus,
    'failed',
  );
  await command(a, faq, 'prepare', 202);
  faq = await detail(a, faq);
  const retry = await prisma.outboxEvent.findFirstOrThrow({
    where: {
      aggregateId: faq.currentVersion.id,
      eventType: 'knowledge.prepare.requested',
      aggregateVersion: 2,
    },
  });
  await job.remove();
  await publisher.publish(event);
  assert.equal(
    await publisher.queue.getJob(`${faq.currentVersion.id}-1`),
    undefined,
  );
  docker('stop', container);
  await assert.rejects(publisher.publish(retry));
  assert.equal(
    (await prisma.outboxEvent.findUniqueOrThrow({ where: { id: retry.id } }))
      .status,
    'pending',
  );
  docker('start', container);
  await until(async () => {
    try {
      await publisher.publish(retry);
      return true;
    } catch {
      return false;
    }
  }, 'Redis recovery');
  assert.ok(await publisher.queue.getJob(`${faq.currentVersion.id}-2`));
  pass('失败后新命令新尝试、旧命令不重启、旧尝试迟到无效、Redis失败可恢复');

  const old = faq.currentVersion.id,
    rev0 = await revision(a);
  await readyFixture(faq);
  faq = await command(a, faq, 'enable');
  assert.equal(await revision(a), rev0 + 1);
  assert.ok((await usable(a)).includes(faq.id));
  assert.equal(
    (await detail(agent, faq)).currentVersion.body,
    faq.currentVersion.body,
  );
  await request(agent, 'GET', `/knowledge/${faq.id}/versions`, undefined, 403);
  await command(agent, faq, 'disable', 403);
  await request(a, 'DELETE', `/knowledge/${faq.id}`, {}, 409, {
    headers: { 'If-Match': String(faq.version) },
  });
  const editBody = {
    expectedVersion: faq.version,
    titleOrQuestion: '新版问题',
    body: '新版正文',
  };
  const competing = await Promise.all([
    request(a, 'PATCH', `/knowledge/${faq.id}`, editBody, [200, 409]),
    request(
      a,
      'PATCH',
      `/knowledge/${faq.id}`,
      { ...editBody, body: '竞争正文' },
      [200, 409],
      { api: second },
    ),
  ]);
  assert.deepEqual(competing.map((x) => x.status).sort(), [200, 409]);
  faq = await detail(a, faq);
  assert.equal(faq.status, 'draft');
  assert.equal(faq.currentVersion.revision, 2);
  assert.ok(!(await usable(a)).includes(faq.id));
  assert.equal(await revision(a), rev0 + 2);
  await request(agent, 'GET', `/knowledge/${faq.id}`, undefined, 404);
  await command(a, faq, 'prepare', 409, { versionId: old });
  await command(a, faq, 'enable', 409, { versionId: old });
  await assert.rejects(
    db.query('UPDATE knowledge_versions SET body=$1 WHERE id=$2', [
      'tamper',
      old,
    ]),
    /immutable/,
  );
  assert.equal(
    (await db.query('SELECT body FROM knowledge_versions WHERE id=$1', [old]))
      .rows[0].body,
    '合成内容，不代表实际政策。',
  );
  const history = (await request(a, 'GET', `/knowledge/${faq.id}/versions`))
    .data.items;
  assert.equal(history.length, 2);
  assert.ok(history.every((v) => !('body' in v) && !('embedding' in v)));
  await publisher.publish(retry);
  assert.equal(
    (await detail(a, faq)).currentVersion.preparationRequested,
    false,
  );
  pass(
    '合成ready夹具下显式启用、并发编辑仅一胜、立即撤出集合、不可变旧正文/版本可追溯',
  );

  await readyFixture(doc);
  doc = await command(a, doc, 'enable');
  const race = await Promise.all([
    command(a, doc, 'disable', [200, 409]),
    request(
      a,
      'PATCH',
      `/knowledge/${doc.id}`,
      { expectedVersion: doc.version, titleOrQuestion: 'race', body: 'race' },
      [200, 409],
      { api: second },
    ),
  ]);
  assert.equal(race.filter((x) => x?.id).length, 1);
  doc = await detail(a, doc);
  assert.ok(!(await usable(a)).includes(doc.id));
  if (doc.status !== 'disabled') doc = await command(a, doc, 'disable');
  const deleteKey = randomUUID();
  await request(a, 'DELETE', `/knowledge/${doc.id}`, {}, 422);
  await request(a, 'DELETE', `/knowledge/${doc.id}`, {}, 409, {
    headers: { 'If-Match': '999' },
  });
  const revDelete = await revision(a);
  for (let i = 0; i < 2; i++)
    await request(a, 'DELETE', `/knowledge/${doc.id}`, {}, 204, {
      key: deleteKey,
      headers: { 'If-Match': `"${doc.version}"` },
    });
  assert.equal(await revision(a), revDelete + 1);
  await request(a, 'GET', `/knowledge/${doc.id}`, undefined, 404);
  await request(a, 'GET', `/knowledge/${doc.id}/versions`, undefined, 404);
  assert.ok(
    (
      await db.query('SELECT id FROM knowledge_versions WHERE document_id=$1', [
        doc.id,
      ])
    ).rowCount > 0,
  );
  pass('启用后停用/编辑竞争、If-Match、软删除和重复删除保留历史版本');

  const off = await create(a, 'faq', { api: disabled });
  assert.equal(
    (
      await request(
        a,
        'POST',
        `/knowledge/${off.id}/prepare`,
        { versionId: off.currentVersion.id },
        503,
        { api: disabled },
      )
    ).error.code,
    'AI_UNAVAILABLE',
  );
  assert.equal(
    (
      await request(
        a,
        'POST',
        `/knowledge/${off.id}/prepare`,
        { versionId: off.currentVersion.id },
        409,
      )
    ).error.code,
    'EMBEDDING_PROFILE_CHANGED',
  );
  assert.equal(
    await prisma.outboxEvent.count({
      where: { aggregateId: off.currentVersion.id, destination: 'queue' },
    }),
    0,
  );
  await request(a, 'PATCH', `/memberships/${agent.membershipId}`, {
    expectedVersion: joined.membership.version,
    status: 'disabled',
  });
  await request(agent, 'GET', '/knowledge', undefined, 404);
  pass('无模型配置可存草稿但不可准备、配置切换需新版本、成员停用立即失效');

  const audits = await db.query(
    "SELECT action, count(*)::int n FROM audit_events WHERE resource_type='knowledge' GROUP BY action",
  );
  for (const action of [
    'create',
    'edit',
    'prepare',
    'enable',
    'disable',
    'delete',
  ])
    assert.ok(audits.rows.some((r) => r.action === 'knowledge.' + action));
  const privateFields = [
    'embeddingModelId',
    'embeddingDimensions',
    'leaseToken',
    'contentHash',
    'organizationId',
  ];
  for (const field of privateFields)
    assert.ok(
      !JSON.stringify(await detail(a, faq)).includes('"' + field + '"'),
    );
  pass('九接口实际调用、六类变更审计、DTO不泄漏内部配置与租约');

  const rollbackKey = randomUUID();
  const countBefore = await prisma.knowledgeDocument.count();
  await db.query(
    "CREATE FUNCTION t11_reject_outbox() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event_type='knowledge.updated' THEN RAISE EXCEPTION 'T11 rollback'; END IF; RETURN NEW; END $$; CREATE TRIGGER t11_reject BEFORE INSERT ON outbox_events FOR EACH ROW EXECUTE FUNCTION t11_reject_outbox()",
  );
  try {
    await request(a, 'POST', '/knowledge', body, 503, { key: rollbackKey });
  } finally {
    await db.query(
      'DROP TRIGGER t11_reject ON outbox_events; DROP FUNCTION t11_reject_outbox()',
    );
  }
  assert.equal(await prisma.knowledgeDocument.count(), countBefore);
  assert.equal(
    await prisma.operationReceipt.count({ where: { commandId: rollbackKey } }),
    0,
  );
  await request(a, 'POST', '/knowledge', body, 201, { key: rollbackKey });
  const repeatReady = await create(a);
  await readyFixture(repeatReady);
  assert.equal(
    (await command(a, repeatReady, 'prepare', 202)).preparationStatus,
    'ready',
  );
  assert.equal(
    await prisma.outboxEvent.count({
      where: {
        aggregateId: repeatReady.currentVersion.id,
        destination: 'queue',
      },
    }),
    0,
  );
  pass('Outbox插入故障整笔回滚后原键重试、ready重复prepare不降级');

  const streaming = await start('fake', true);
  const liveEvents = new Map();
  for (const account of [a, b]) {
    const socket = io(streaming + '/support', {
      transports: ['websocket'],
      autoConnect: false,
      reconnection: false,
      extraHeaders: { Origin: origin, Cookie: account.cookie },
      auth: { organizationId: account.org },
    });
    const events = [];
    liveEvents.set(account.org, events);
    sockets.push(socket);
    socket.on('knowledge.updated', (event) => events.push(event));
    const connected = new Promise((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('connect_error', reject);
    });
    socket.connect();
    await connected;
  }
  const streamed = await create(a);
  await until(
    () => liveEvents.get(a.org).some((e) => e.data.id === streamed.id),
    'knowledge socket',
  );
  const observed = liveEvents.get(a.org).find((e) => e.data.id === streamed.id);
  assert.equal(observed.data.preparationStatus, 'not_started');
  assert.ok(!JSON.stringify(observed).includes('body'));
  assert.ok(!liveEvents.get(b.org).some((e) => e.data.id === streamed.id));
  await command(a, streamed, 'prepare', 202);
  await until(
    async () =>
      !!(await publisher.queue.getJob(`${streamed.currentVersion.id}-1`)),
    'API outbox real delivery',
  );
  pass(
    '实际Socket知识事件公开状态且无正文/跨企业泄漏、API Outbox自动投递准备job',
  );
  const probe = spawnSync(
    process.execPath,
    [
      process.env.KNOWLEDGE_API_ARCHIVE ??
        resolve(root, 'tests/integration/knowledge-api.mjs'),
    ],
    {
      cwd: root,
      windowsHide: true,
      encoding: 'utf8',
      env: {
        ...process.env,
        PROJECT_ROOT: root,
        API_BASE_URL: api,
        APP_ORIGIN: origin,
        API_COOKIE: a.cookie,
        API_ORG: a.org,
        API_READY_ID: repeatReady.id,
      },
    },
  );
  await writeFile(
    resolve(evidence, 'api-verification.log'),
    probe.stdout + probe.stderr,
  );
  assert.equal(probe.status, 0, probe.stdout + probe.stderr);
  pass('归档九接口脚本连接现有隔离实例并完成持久化读回');
  await writeFile(
    resolve(evidence, 'results.json'),
    JSON.stringify(
      {
        result: 'PASS',
        scenarios: results,
        modelCalls: 0,
        readyFixture: 'synthetic database state only',
        isolatedDatabase: name,
        redisContainer: container,
        api,
        second,
        disabled,
      },
      null,
      2,
    ),
  );
} finally {
  for (const socket of sockets) socket.disconnect();
  await publisher?.close();
  await prisma?.$disconnect();
  for (const item of children.reverse()) {
    if (!item.exit) item.child.kill();
    await item.done;
    await writeFile(resolve(evidence, `api-${item.pid}.log`), item.output);
    console.info(
      JSON.stringify({ stopped: item.pid, url: item.url, exit: item.exit }),
    );
    await assert.rejects(() => fetch(item.url + '/health/live'));
  }
  if (redisStarted) docker('rm', '-f', container);
  if (connected) await db.end();
  if (created) await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
  if (before) {
    const after = await snapshot();
    await writeFile(
      resolve(evidence, 'main-after.json'),
      JSON.stringify(after, null, 2),
    );
    assert.deepEqual(after, before, 'experience data changed');
  }
  await writeFile(
    resolve(evidence, 'http-calls.json'),
    JSON.stringify(calls, null, 2),
  );
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
  console.info(
    `CLEANUP PASS; scenarios=${results.length}; main public tables unchanged`,
  );
}
