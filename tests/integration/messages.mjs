import assert from 'node:assert/strict';
import console from 'node:console';
import process from 'node:process';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, URL } from 'node:url';
import { resolve } from 'node:path';
import { chromium } from '@playwright/test';

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
assert.ok(['127.0.0.1', 'localhost'].includes(base.hostname));
const name = `smartdesk_t05_${process.pid}_${Date.now()}`;
assert.match(name, /^smartdesk_t05_\d+_\d+$/);
const adminUrl = new URL(base);
adminUrl.pathname = '/postgres';
const testUrl = new URL(base);
testUrl.pathname = '/' + name;
assert.notEqual(base.pathname, testUrl.pathname);
const admin = new Client({ connectionString: adminUrl.href });
const main = new Client({ connectionString: base.href });
const db = new Client({ connectionString: testUrl.href });
const evidence = resolve(root, 'test-results/messages');
const children = [];
const results = [];
let browser,
  before,
  created = false,
  connected = false;
let api, second;
const parentOrigin = 'https://customer.example.test';
const messageKeys = [
  'id',
  'conversationId',
  'senderId',
  'senderType',
  'clientMessageId',
  'seq',
  'content',
  'createdAt',
  'conversationVersion',
].sort();
function pass(label) {
  results.push(label);
  console.info('PASS ' + label);
}
async function freePort() {
  const s = createServer();
  await new Promise((ok) => s.listen(0, '127.0.0.1', ok));
  const port = s.address().port;
  await new Promise((ok) => s.close(ok));
  return port;
}
async function snapshot(client = main, legacy = false) {
  const tables = (
    await client.query(
      "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename",
    )
  ).rows;
  const data = {};
  for (const { tablename } of tables) {
    assert.match(tablename, /^[a-z_]+$/);
    const expr =
      legacy && tablename === 'messages'
        ? "to_jsonb(t)-'conversation_version'"
        : 'to_jsonb(t)';
    data[tablename] = (
      await client.query(
        `SELECT count(*)::int AS count, md5(coalesce(string_agg((${expr})::text, '' ORDER BY (${expr})::text),'')) AS digest FROM "${tablename}" t`,
      )
    ).rows[0];
  }
  return data;
}
async function start(port, mode = 'fake') {
  const script = resolve(root, 'apps/server/dist/main.js');
  const child = spawn(process.execPath, [script], {
    cwd: root,
    windowsHide: true,
    env: {
      ...process.env,
      DATABASE_URL: testUrl.href,
      API_HOST: '127.0.0.1',
      API_PORT: String(port),
      APP_ORIGIN: api,
      WIDGET_ORIGIN: api,
      AI_MODE: mode,
      REDIS_URL: 'redis://127.0.0.1:1',
      AI_SERVICE_URL: 'http://127.0.0.1:1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const item = {
    child,
    port,
    output: '',
    exit: null,
    command: `node ${script}`,
    cwd: root,
    mode,
  };
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
      start: mode,
      command: item.command,
      cwd: root,
      pid: child.pid,
      port,
    }),
  );
  for (let i = 0; i < 100; i++) {
    if (item.exit) throw new Error(item.output);
    try {
      if (
        (
          await fetch(`http://127.0.0.1:${port}/health/live`, {
            signal: AbortSignal.timeout(1000),
          })
        ).ok
      )
        return item;
    } catch {
      /* startup */
    }
    await delay(100);
  }
  throw new Error('API startup timed out');
}
async function request(actor, method, path, body, options = {}) {
  const response = await fetch((options.api ?? api) + '/api/v1' + path, {
    method,
    signal: AbortSignal.timeout(15000),
    headers: Object.fromEntries(
      Object.entries({
        Origin: api,
        'Content-Type': 'application/json',
        'X-Requested-With': 'SmartDesk',
        'Idempotency-Key': options.key ?? randomUUID(),
        ...(actor?.token
          ? { Authorization: `Bearer ${actor.token}` }
          : actor?.cookie
            ? {
                Cookie: actor.cookie,
                ...(actor.org ? { 'X-Organization-Id': actor.org } : {}),
              }
            : {}),
        ...options.headers,
      }).filter(([, value]) => value !== undefined),
    ),
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const value = response.status === 204 ? null : await response.json();
  assert.equal(response.headers.get('cache-control'), 'no-store');
  if (options.status !== undefined)
    assert.equal(response.status, options.status, JSON.stringify(value));
  if (options.code) assert.equal(value?.error?.code, options.code);
  return {
    status: response.status,
    data: value?.data,
    error: value?.error,
    cookie: response.headers.get('set-cookie')?.split(';')[0],
  };
}
async function user(label) {
  return request(
    null,
    'POST',
    '/auth/register',
    {
      email: `${label}@t05.invalid`,
      password: 'T05-test-password-29!',
      displayName: label,
    },
    { status: 201 },
  );
}
async function organization(actor, label) {
  const org = await request(
    actor,
    'POST',
    '/organizations',
    { name: label },
    { status: 201 },
  );
  actor.org = org.data.id;
  const config = (
    await request(actor, 'GET', '/widget-config', undefined, { status: 200 })
  ).data;
  await request(
    actor,
    'PATCH',
    '/widget-config',
    {
      expectedVersion: config.version,
      allowedOrigins: [parentOrigin],
      enabled: true,
    },
    { status: 200 },
  );
  return config.publicKey;
}
async function visitor(publicKey, customer) {
  const r = await request(
    null,
    'POST',
    `/public/widgets/${publicKey}/bootstrap`,
    customer ?? {},
    { status: 201, headers: { Origin: parentOrigin } },
  );
  return { token: r.data.visitorToken, customer: r.data.customer };
}
const input = (content = '首条实际消息') => ({
  clientConversationId: randomUUID(),
  firstMessage: { clientMessageId: randomUUID(), content },
});
async function send(actor, cid, content, options = {}) {
  return request(
    actor,
    'POST',
    `/conversations/${cid}/messages`,
    { clientMessageId: options.id ?? randomUUID(), content },
    options,
  );
}
async function fact(cid) {
  return (
    await db.query(
      "SELECT c.*, (SELECT count(*)::int FROM messages m WHERE m.conversation_id=c.id) AS message_count, (SELECT count(*)::int FROM outbox_events o WHERE o.aggregate_id=c.id OR o.payload->'data'->>'conversationId'=c.id::text) AS event_count FROM conversations c WHERE c.id=$1",
      [cid],
    )
  ).rows[0];
}
async function fault(table, action) {
  assert.ok(
    ['messages', 'outbox_events', 'ai_tasks', 'operation_receipts'].includes(
      table,
    ),
  );
  await db.query(
    `CREATE TRIGGER t05_failure BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION t05_fail()`,
  );
  try {
    await action();
  } finally {
    await db.query(`DROP TRIGGER t05_failure ON ${table}`);
  }
}
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
  await db.connect();
  connected = true;
  // Upgrade populated T02 schema, then baseline it so migrate deploy validates the real chain.
  for (const migration of ['202611060001_initial', '202611060002_integrity']) {
    await db.query(
      await readFile(
        resolve(root, 'database/migrations', migration, 'migration.sql'),
        'utf8',
      ),
    );
    const r = spawnSync(
      process.execPath,
      [
        rootRequire.resolve('prisma/build/index.js'),
        'migrate',
        'resolve',
        '--applied',
        migration,
      ],
      {
        cwd: root,
        env: { ...process.env, DATABASE_URL: testUrl.href },
        encoding: 'utf8',
        windowsHide: true,
      },
    );
    assert.equal(r.status, 0, r.stdout + r.stderr);
  }
  await db.query(await readFile(resolve(root, 'database/seed.sql'), 'utf8'));
  const legacyBefore = await snapshot(db, true);
  delete legacyBefore._prisma_migrations;
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
  await writeFile(
    resolve(evidence, 'migration.log'),
    migration.stdout + migration.stderr,
  );
  const legacyAfter = await snapshot(db, true);
  delete legacyAfter._prisma_migrations;
  assert.deepEqual(legacyAfter, legacyBefore);
  assert.equal(
    (await db.query('SELECT conversation_version FROM messages LIMIT 1'))
      .rows[0].conversation_version,
    0,
  );
  await assert.rejects(
    db.query('UPDATE messages SET conversation_version=1'),
    /immutable/,
  );
  // Revert additive DDL inside an explicit rollback only; retained schema stays upgraded.
  await db.query('BEGIN');
  await db.query(
    'DROP TRIGGER message_version_immutable ON messages; ALTER TABLE messages DROP COLUMN conversation_version',
  );
  await db.query('ROLLBACK');
  assert.equal(
    (await db.query('SELECT conversation_version FROM messages LIMIT 1'))
      .rows[0].conversation_version,
    0,
  );
  pass(
    'populated migration preserves all legacy fields; immutable version; rollback dry-run',
  );
  const p1 = await freePort(),
    p2 = await freePort();
  api = `http://127.0.0.1:${p1}`;
  second = `http://127.0.0.1:${p2}`;
  await start(p1);
  await start(p2);
  const owner = await user('owner');
  const other = await user('other');
  const agent = await user('agent');
  const publicKey = await organization(owner, '消息事务企业A');
  const otherKey = await organization(other, '消息事务企业B');
  const invite = (
    await request(
      owner,
      'POST',
      '/invitations',
      { role: 'agent' },
      { status: 201 },
    )
  ).data;
  await request(
    agent,
    'POST',
    '/invitations/accept',
    { token: new URL(invite.inviteLink).hash.slice(1) },
    { status: 200 },
  );
  agent.org = owner.org;
  const memberships = (
    await request(owner, 'GET', '/memberships', undefined, { status: 200 })
  ).data.items;
  const ownerId = memberships.find((m) => m.role === 'admin').id;
  const agentId = memberships.find((m) => m.role === 'agent').id;
  const v = await visitor(publicKey),
    stranger = await visitor(publicKey),
    foreign = await visitor(otherKey);
  const beforeCount = (
    await db.query('SELECT count(*)::int n FROM conversations')
  ).rows[0].n;
  await request(v, 'GET', '/conversations', undefined, { status: 200 });
  await request(v, 'GET', '/conversations', undefined, { status: 200 });
  await request(
    v,
    'POST',
    '/conversations',
    { clientConversationId: randomUUID() },
    { status: 422 },
  );
  assert.equal(
    (await db.query('SELECT count(*)::int n FROM conversations')).rows[0].n,
    beforeCount,
  );
  const first = input();
  const key = randomUUID();
  const createdResults = await Promise.all(
    Array.from({ length: 12 }, (_, i) =>
      request(v, 'POST', '/conversations', first, {
        key,
        api: i % 2 ? second : api,
      }),
    ),
  );
  assert.equal(createdResults.filter((r) => r.status === 201).length, 1);
  assert.equal(createdResults.filter((r) => r.status === 200).length, 11);
  const saved = createdResults[0].data;
  const cid = saved.conversation.id;
  for (const r of createdResults)
    assert.deepEqual(r.data.message, saved.message);
  assert.deepEqual(Object.keys(saved.message).sort(), messageKeys);
  const f = await fact(cid);
  assert.equal(f.message_count, 1);
  assert.equal(f.last_seq, 1);
  assert.equal(f.input_revision, 1);
  assert.equal(f.created_at.toISOString(), saved.message.createdAt);
  assert.equal(f.first_handoff_at.toISOString(), saved.message.createdAt);
  assert.equal(f.status, 'waiting_human');
  assert.equal(f.first_handoff_reason, 'ai_unavailable');
  assert.equal(
    (await request(v, 'POST', '/conversations', first, { status: 200 })).data
      .message.id,
    saved.message.id,
  );
  await request(
    v,
    'POST',
    '/conversations',
    {
      ...first,
      firstMessage: { ...first.firstMessage, content: '不同首消息' },
    },
    { key, status: 409, code: 'IDEMPOTENCY_CONFLICT' },
  );
  await request(v, 'POST', '/conversations', input(), {
    key,
    status: 409,
    code: 'IDEMPOTENCY_CONFLICT',
  });
  pass(
    'two API processes: 12 concurrent first messages create one conversation/message; no empty conversations',
  );
  const mid = randomUUID();
  const same = await Promise.all(
    Array.from({ length: 16 }, (_, i) =>
      send(v, cid, '同ID并发', { id: mid, api: i % 2 ? second : api }),
    ),
  );
  assert.equal(same.filter((r) => r.status === 201).length, 1);
  assert.equal(same.filter((r) => r.status === 200).length, 15);
  for (const r of same) assert.deepEqual(r.data, same[0].data);
  await send(v, cid, '换正文', {
    id: mid,
    status: 409,
    code: 'IDEMPOTENCY_CONFLICT',
  });
  const unique = await Promise.all(
    Array.from({ length: 20 }, (_, i) =>
      send(v, cid, `并发${i}`, { api: i % 2 ? second : api, status: 201 }),
    ),
  );
  assert.deepEqual(
    unique.map((r) => r.data.seq).sort((a, b) => a - b),
    Array.from({ length: 20 }, (_, i) => i + 3),
  );
  const allSeq = (
    await db.query(
      'SELECT seq FROM messages WHERE conversation_id=$1 ORDER BY seq',
      [cid],
    )
  ).rows.map((r) => r.seq);
  assert.deepEqual(
    allSeq,
    Array.from({ length: 22 }, (_, i) => i + 1),
  );
  assert.equal(
    (
      await db.query(
        "SELECT count(*)::int n FROM outbox_events WHERE event_type='message.created' AND payload->'data'->>'conversationId'=$1",
        [cid],
      )
    ).rows[0].n,
    22,
  );
  pass(
    'two API processes: idempotency, conflict, 20 distinct concurrent messages have contiguous seq and outbox',
  );
  // Consume transport response without its body: caller loses ACK despite committed database fact.
  const conflictingId = randomUUID();
  const conflictRace = await Promise.all([
    send(v, cid, '竞争正文A', { id: conflictingId }),
    send(v, cid, '竞争正文B', { id: conflictingId, api: second }),
  ]);
  assert.deepEqual(conflictRace.map((r) => r.status).sort(), [201, 409]);
  assert.equal(
    conflictRace.find((r) => r.status === 409).error.code,
    'IDEMPOTENCY_CONFLICT',
  );
  assert.equal(
    (
      await db.query(
        'SELECT count(*)::int n FROM messages WHERE conversation_id=$1 AND client_message_id=$2',
        [cid, conflictingId],
      )
    ).rows[0].n,
    1,
  );
  pass(
    'simultaneous different bodies with the same ID commit only one message',
  );
  const lostId = randomUUID();
  const lost = await fetch(api + `/api/v1/conversations/${cid}/messages`, {
    method: 'POST',
    headers: {
      Origin: api,
      Authorization: `Bearer ${v.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ clientMessageId: lostId, content: '丢失响应正文' }),
  });
  await lost.body.cancel();
  const recovered = await request(
    v,
    'GET',
    `/conversations/${cid}/message-requests/${lostId}`,
    undefined,
    { status: 200 },
  );
  assert.deepEqual(
    (await send(v, cid, '丢失响应正文', { id: lostId, status: 200 })).data,
    recovered.data,
  );
  await request(
    v,
    'GET',
    `/conversations/${cid}/message-requests/${randomUUID()}`,
    undefined,
    { status: 404, code: 'REQUEST_NOT_FOUND' },
  );
  pass(
    'lost ACK recovered by original sender request lookup and original ID retry',
  );
  for (const outsider of [stranger, foreign, other]) {
    await request(outsider, 'GET', `/conversations/${cid}`, undefined, {
      status: 404,
    });
    await request(
      outsider,
      'GET',
      `/conversations/${cid}/messages`,
      undefined,
      { status: 404 },
    );
    await request(
      outsider,
      'GET',
      `/conversations/${cid}/message-requests/${lostId}`,
      undefined,
      { status: 404 },
    );
    await send(outsider, cid, '不可保存', { status: 404 });
  }
  await request(
    owner,
    'GET',
    `/conversations/${cid}/message-requests/${lostId}`,
    undefined,
    { status: 404, code: 'REQUEST_NOT_FOUND' },
  );
  await request(
    v,
    'GET',
    '/conversations?customerId=' + stranger.customer.id,
    undefined,
    { status: 422 },
  );
  await request(v, 'GET', '/conversations', undefined, {
    status: 422,
    headers: { 'X-Organization-Id': owner.org },
  });
  await request(
    v,
    'POST',
    `/conversations/${cid}/messages`,
    { clientMessageId: randomUUID(), content: '冒认', senderType: 'ai' },
    { status: 422 },
  );
  await request(owner, 'POST', '/conversations', input(), { status: 403 });
  await send(owner, cid, '未接管管理员', { status: 403, code: 'NOT_ASSIGNEE' });
  await send(agent, cid, '未认领客服', { status: 403, code: 'NOT_ASSIGNEE' });
  await request(owner, 'GET', `/conversations/${cid}`, undefined, {
    status: 401,
    headers: {
      Authorization: 'Bearer invalid',
      'X-Organization-Id': undefined,
    },
  });
  pass(
    'current tenant/customer/member ACL, sender-only lookup and Cookie/Bearer separation',
  );
  await db.query(
    'INSERT INTO conversation_notes (organization_id,conversation_id,author_membership_id,client_note_id,content) VALUES ($1,$2,$3,$4,$5)',
    [owner.org, cid, ownerId, randomUUID(), '内部秘密备注不得公开'],
  );
  const watermark = (await fact(cid)).last_seq;
  const latest = (
    await request(
      v,
      'GET',
      `/conversations/${cid}/messages?limit=5`,
      undefined,
      { status: 200 },
    )
  ).data;
  assert.equal(latest.snapshotThroughSeq, watermark);
  assert.equal(latest.items.length, 5);
  assert.equal(latest.mode, 'latest');
  await send(v, cid, '快照之后新消息', { status: 201 });
  let page = latest;
  const history = [...page.items];
  while (page.hasMore) {
    page = (
      await request(
        v,
        'GET',
        `/conversations/${cid}/messages?cursor=${page.nextCursor}&limit=5`,
        undefined,
        { status: 200 },
      )
    ).data;
    assert.equal(page.snapshotThroughSeq, watermark);
    history.unshift(...page.items);
  }
  assert.deepEqual(
    history.map((m) => m.seq),
    Array.from({ length: watermark }, (_, i) => i + 1),
  );
  assert.ok(!JSON.stringify(history).includes('内部秘密'));
  for (const m of history) assert.deepEqual(Object.keys(m).sort(), messageKeys);
  let after = (
    await request(
      v,
      'GET',
      `/conversations/${cid}/messages?afterSeq=0&limit=4&throughSeq=${watermark}`,
      undefined,
      { status: 200 },
    )
  ).data;
  const forward = [...after.items];
  while (after.hasMore) {
    after = (
      await request(
        v,
        'GET',
        `/conversations/${cid}/messages?cursor=${after.nextCursor}&limit=4`,
        undefined,
        { status: 200 },
      )
    ).data;
    assert.equal(after.snapshotThroughSeq, watermark);
    forward.push(...after.items);
  }
  assert.deepEqual(forward, history);
  assert.deepEqual(
    (
      await request(
        v,
        'GET',
        `/conversations/${cid}/messages?beforeSeq=6&limit=5`,
        undefined,
        { status: 200 },
      )
    ).data.items.map((m) => m.seq),
    [1, 2, 3, 4, 5],
  );
  assert.equal(
    (
      await request(
        v,
        'GET',
        `/conversations/${cid}/messages?afterSeq=${watermark}`,
        undefined,
        { status: 200 },
      )
    ).data.items.length,
    1,
  );
  for (const q of [
    'afterSeq=0&beforeSeq=2',
    'afterSeq=-1',
    'limit=101',
    'throughSeq=99999',
    'beforeSeq=0',
    'cursor=invalid',
    'limit=2&limit=3',
  ])
    await request(v, 'GET', `/conversations/${cid}/messages?${q}`, undefined, {
      status: 422,
    });
  const another = (
    await request(v, 'POST', '/conversations', input('另一会话'), {
      status: 201,
    })
  ).data.conversation.id;
  await request(
    v,
    'GET',
    `/conversations/${another}/messages?cursor=${latest.nextCursor}`,
    undefined,
    { status: 422 },
  );
  const list = (
    await request(v, 'GET', '/conversations?limit=1', undefined, {
      status: 200,
    })
  ).data;
  assert.equal(list.items.length, 1);
  assert.ok(list.nextCursor);
  assert.equal(
    (
      await request(
        v,
        'GET',
        `/conversations?limit=1&cursor=${list.nextCursor}`,
        undefined,
        { status: 200 },
      )
    ).data.items[0].id,
    cid,
  );
  await request(
    stranger,
    'GET',
    `/conversations?cursor=${list.nextCursor}`,
    undefined,
    { status: 422 },
  );
  pass(
    'stable latest/before/after pages, fixed watermark during append, scoped cursor and notes excluded',
  );
  for (const content of ['', '   ', '😀'.repeat(8001), '\0', '\ud800'])
    await send(v, cid, content, { status: 422 });
  await send(v, cid, '😀'.repeat(8000), { status: 201 });
  await send(v, cid, ' 原文空格保留 ', { status: 201 });
  pass(
    'Unicode code-point limit, invalid text rejection and original body preservation',
  );
  await db.query(
    "UPDATE conversations SET status='human_active',assigned_membership_id=$2,version=version+1,reception_epoch=reception_epoch+1 WHERE id=$1",
    [cid, agentId],
  );
  const humanId = randomUUID();
  const human = await send(agent, cid, '真人第一条', {
    id: humanId,
    status: 201,
  });
  const firstHuman = await fact(cid);
  assert.equal(
    firstHuman.first_human_reply_at.toISOString(),
    human.data.createdAt,
  );
  assert.equal(firstHuman.first_human_reply_membership_id, agentId);
  await send(agent, cid, '真人第二条', { status: 201 });
  assert.equal(
    (await fact(cid)).first_human_reply_at.toISOString(),
    human.data.createdAt,
  );
  assert.ok(
    (
      await request(owner, 'GET', `/conversations/${cid}`, undefined, {
        status: 200,
      })
    ).data.unreadCount > 0,
  );
  assert.ok(
    !(
      'unreadCount' in
      (
        await request(v, 'GET', `/conversations/${cid}`, undefined, {
          status: 200,
        })
      ).data
    ),
  );
  await send(agent, cid, 'CSRF负例', {
    status: 403,
    code: 'CSRF_REJECTED',
    headers: { Origin: parentOrigin },
  });
  await db.query(
    "UPDATE conversations SET status='closed',closed_at=now(),resolution='unconfirmed',version=version+1 WHERE id=$1",
    [cid],
  );
  assert.deepEqual(
    (await send(v, cid, '丢失响应正文', { id: lostId, status: 200 })).data,
    recovered.data,
  );
  assert.deepEqual(
    (await send(agent, cid, '真人第一条', { id: humanId, status: 200 })).data,
    human.data,
  );
  assert.deepEqual(
    (await request(v, 'POST', '/conversations', first, { key, status: 200 }))
      .data.message,
    saved.message,
  );
  await send(v, cid, '关闭后新消息', {
    status: 409,
    code: 'CONVERSATION_CLOSED',
  });
  await db.query(
    'UPDATE conversations SET assigned_membership_id=$2 WHERE id=$1',
    [cid, ownerId],
  );
  await send(agent, cid, '真人第一条', { id: humanId, status: 404 });
  await request(
    agent,
    'GET',
    `/conversations/${cid}/message-requests/${humanId}`,
    undefined,
    { status: 404 },
  );
  await db.query("UPDATE memberships SET status='disabled' WHERE id=$1", [
    agentId,
  ]);
  await request(agent, 'GET', '/conversations', undefined, { status: 404 });
  pass(
    'first human reply facts, admin takeover requirement, closed retry identity and revoked read access',
  );
  await db.query(
    "CREATE FUNCTION t05_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'T05 injected database failure'; END $$",
  );
  for (const table of ['messages', 'outbox_events', 'operation_receipts']) {
    const b = input('回滚' + table);
    const counts = await snapshot(db);
    await fault(table, async () => {
      await request(v, 'POST', '/conversations', b, {
        status: 503,
        code: 'SERVICE_UNAVAILABLE',
      });
      assert.deepEqual(await snapshot(db), counts);
    });
    await request(v, 'POST', '/conversations', b, { status: 201 });
  }
  const sendFail = randomUUID();
  const old = await fact(another);
  await fault('outbox_events', async () => {
    await send(v, another, '发送失败重试', { id: sendFail, status: 503 });
    assert.deepEqual(await fact(another), old);
    await request(
      v,
      'GET',
      `/conversations/${another}/message-requests/${sendFail}`,
      undefined,
      { status: 404 },
    );
  });
  await send(v, another, '发送失败重试', { id: sendFail, status: 201 });
  pass(
    'real database failure at message/outbox/receipt rolls back conversation+seq; original request can retry',
  );
  await db.query(
    'UPDATE organizations SET ai_enabled=true,ai_config_revision=3,knowledge_revision=5 WHERE id=$1',
    [owner.org],
  );
  const noKnowledge = (
    await request(v, 'POST', '/conversations', input('无知识'), { status: 201 })
  ).data;
  assert.equal(noKnowledge.conversation.status, 'waiting_human');
  assert.equal(
    noKnowledge.conversation.handoffReason,
    'knowledge_insufficient',
  );
  const doc = randomUUID(),
    kv = randomUUID();
  await db.query(
    "INSERT INTO knowledge_documents(id,organization_id,type,created_by_membership_id,updated_at) VALUES($1,$2,'faq',$3,now())",
    [doc, owner.org, ownerId],
  );
  await db.query(
    "INSERT INTO knowledge_versions(id,organization_id,document_id,revision,title_or_question,body,content_hash,embedding_profile_version,embedding_model_id,embedding_dimensions,created_by_membership_id,preparation_status,updated_at) VALUES($1,$2,$3,1,'合成问题','合成答案','fixture','fake-v1','fake-embedding-v1',8,$4,'ready',now())",
    [kv, owner.org, doc, ownerId],
  );
  await db.query(
    "UPDATE knowledge_documents SET current_version_id=$2,status='enabled' WHERE id=$1",
    [doc, kv],
  );
  const aiInput = input('任务事实首轮');
  const aiKey = randomUUID();
  const aiBefore = await snapshot(db);
  await fault('ai_tasks', async () => {
    await request(v, 'POST', '/conversations', aiInput, {
      key: aiKey,
      status: 503,
    });
    assert.deepEqual(await snapshot(db), aiBefore);
  });
  const aiConversation = (
    await request(v, 'POST', '/conversations', aiInput, {
      key: aiKey,
      status: 201,
    })
  ).data;
  const aid = aiConversation.conversation.id;
  assert.equal(aiConversation.conversation.status, 'ai_active');
  const task1 = (
    await db.query('SELECT * FROM ai_tasks WHERE conversation_id=$1', [aid])
  ).rows[0];
  assert.equal(task1.status, 'queued');
  assert.equal(task1.input_revision, 1);
  assert.equal(task1.knowledge_revision, 5);
  assert.equal(task1.ai_config_revision, 3);
  assert.equal(task1.model_id, 'fake-chat-v1');
  assert.equal(
    task1.deadline_at.getTime() -
      new Date(aiConversation.message.createdAt).getTime(),
    30000,
  );
  const aiId = randomUUID();
  const activeBeforeFailure = await snapshot(db);
  await fault('ai_tasks', async () => {
    await send(v, aid, '任务事实下一轮', { id: aiId, status: 503 });
    assert.deepEqual(await snapshot(db), activeBeforeFailure);
  });
  await send(v, aid, '任务事实下一轮', { id: aiId, status: 201 });
  await send(v, aid, '任务事实下一轮', { id: aiId, status: 200 });
  const tasks = (
    await db.query(
      'SELECT * FROM ai_tasks WHERE conversation_id=$1 ORDER BY input_revision',
      [aid],
    )
  ).rows;
  assert.equal(tasks.length, 2);
  assert.equal(tasks[0].status, 'superseded');
  assert.equal(tasks[1].status, 'queued');
  assert.equal(tasks[1].input_message_ids.length, 2);
  assert.equal(tasks[1].source_through_seq, 2);
  assert.equal((await fact(aid)).active_ai_task_id, tasks[1].id);
  assert.equal(
    (
      await db.query(
        "SELECT count(*)::int n FROM outbox_events WHERE destination='queue' AND aggregate_id=ANY($1::uuid[])",
        [tasks.map((t) => t.id)],
      )
    ).rows[0].n,
    2,
  );
  assert.equal(
    (
      await db.query(
        'SELECT count(*)::int n FROM ai_results WHERE task_id=ANY($1::uuid[])',
        [tasks.map((t) => t.id)],
      )
    ).rows[0].n,
    0,
  );
  await send(v, noKnowledge.conversation.id, '启用知识也不自动回AI', {
    status: 201,
  });
  assert.equal(
    (await fact(noKnowledge.conversation.id)).status,
    'waiting_human',
  );
  const disabledPort = await freePort();
  await start(disabledPort, 'disabled');
  const disabled = (
    await request(v, 'POST', '/conversations', input('部署未配置模型'), {
      api: `http://127.0.0.1:${disabledPort}`,
      status: 201,
    })
  ).data;
  assert.equal(disabled.conversation.status, 'waiting_human');
  assert.equal(disabled.conversation.handoffReason, 'ai_unavailable');
  await send(v, aid, '已有AI会话配置失效仍保存', {
    api: `http://127.0.0.1:${disabledPort}`,
    status: 201,
  });
  const fallback = await fact(aid);
  assert.equal(fallback.status, 'waiting_human');
  assert.equal(fallback.last_seq, 3);
  assert.equal(fallback.active_ai_task_id, null);
  assert.equal(fallback.first_handoff_reason, 'ai_unavailable');
  assert.equal(
    (await db.query('SELECT status FROM ai_tasks WHERE id=$1', [tasks[1].id]))
      .rows[0].status,
    'superseded',
  );
  pass(
    'AI task facts atomic, fixed model/revisions/deadline, supersession, no model result, disabled and no-knowledge routing',
  );
  browser = await chromium.launch({ headless: true });
  const archive = process.env.MESSAGE_API_VERIFICATION;
  if (archive) {
    const verified = spawnSync(process.execPath, [archive], {
      cwd: root,
      env: {
        ...process.env,
        API_BASE_URL: api,
        WIDGET_ORIGIN: api,
        VISITOR_TOKEN: v.token,
      },
      encoding: 'utf8',
      windowsHide: true,
    });
    await writeFile(
      resolve(evidence, 'archived-api.log'),
      verified.stdout + verified.stderr,
    );
    assert.equal(verified.status, 0, verified.stdout + verified.stderr);
    pass(
      'archived six-endpoint verification against an already running isolated API',
    );
  }
  const pageBrowser = await browser.newPage();
  await pageBrowser.goto(api + '/health/live');
  const observed = [];
  pageBrowser.on('request', (request) => {
    if (request.url().includes(`/conversations/${cid}/messages`))
      observed.push(request.headers());
  });
  const browserResult = await pageBrowser.evaluate(
    async ({ token, cid }) => {
      const r = await fetch(`/api/v1/conversations/${cid}/messages`, {
        credentials: 'omit',
        headers: { Authorization: `Bearer ${token}` },
      });
      return { status: r.status, body: await r.json() };
    },
    { token: v.token, cid },
  );
  assert.equal(browserResult.status, 200);
  assert.equal(observed.length, 1);
  assert.equal(observed[0].origin, undefined);
  await request(v, 'GET', `/conversations/${cid}/messages`, undefined, {
    headers: { Origin: parentOrigin },
    status: 403,
    code: 'ORIGIN_NOT_ALLOWED',
  });
  await request(v, 'GET', `/conversations/${cid}/messages`, undefined, {
    headers: { Origin: '', 'Sec-Fetch-Site': 'cross-site' },
    status: 403,
  });
  await send(v, another, '父站不能直接发消息', {
    headers: { Origin: parentOrigin },
    status: 403,
  });
  await db.query(
    'UPDATE widget_configs SET enabled=false WHERE public_key=$1',
    [publicKey],
  );
  await request(v, 'GET', `/conversations/${cid}/messages`, undefined, {
    status: 403,
  });
  await writeFile(
    resolve(evidence, 'browser-get.json'),
    JSON.stringify(
      {
        status: browserResult.status,
        originAbsent: observed[0].origin === undefined,
        cookieAbsent: observed[0].cookie === undefined,
        messageCount: browserResult.body.data.items.length,
      },
      null,
      2,
    ),
  );
  pass(
    'real Chromium same-origin GET without Origin/Cookie; wrong origin and disabled site denied',
  );
  const empty = (
    await db.query(
      'SELECT count(*)::int n FROM conversations WHERE organization_id=$1 AND last_seq=0',
      [owner.org],
    )
  ).rows[0].n;
  assert.equal(empty, 0);
  pass(
    'all API-created conversations have first messages; Redis/AI offline did not block human transport',
  );
} finally {
  await browser?.close();
  for (const item of children.reverse()) {
    if (!item.exit) item.child.kill();
    await item.done;
    await writeFile(resolve(evidence, `api-${item.port}.log`), item.output);
    console.info(
      JSON.stringify({
        stopped: item.child.pid,
        port: item.port,
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
    assert.deepEqual(after, before);
    pass('main database all row digests unchanged');
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
  for (const item of children)
    await assert.rejects(() => fetch(`http://127.0.0.1:${item.port}`));
  await writeFile(
    resolve(evidence, 'result.json'),
    JSON.stringify(
      {
        scenarios: results,
        database: name,
        children: children.map((c) => ({
          pid: c.child.pid,
          port: c.port,
          command: c.command,
          cwd: c.cwd,
          mode: c.mode,
          exit: c.exit,
        })),
        cleanup: 'PASS',
      },
      null,
      2,
    ),
  );
  console.info(
    'CLEANUP PASS owned database removed, ports released; scenarios=' +
      results.length,
  );
}
