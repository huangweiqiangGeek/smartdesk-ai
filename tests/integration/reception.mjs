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
import { chromium } from '@playwright/test';
import ts from 'typescript';

const root = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(
  new URL('../../apps/server/package.json', import.meta.url),
);
require('dotenv').config({ path: resolve(root, '.env'), quiet: true });
const { Client } = require('pg'),
  { io } = require('socket.io-client');
const base = new URL(process.env.DATABASE_URL);
assert.ok(['localhost', '127.0.0.1'].includes(base.hostname));
const name = `smartdesk_t08_${process.pid}_${Date.now()}`;
assert.match(name, /^smartdesk_t08_\d+_\d+$/);
const adminUrl = new URL(base),
  testUrl = new URL(base);
adminUrl.pathname = '/postgres';
testUrl.pathname = '/' + name;
assert.notEqual(testUrl.pathname, base.pathname);
const admin = new Client({ connectionString: adminUrl.href });
const main = new Client({ connectionString: base.href });
const db = new Client({ connectionString: testUrl.href });
const evidence = resolve(root, 'test-results/reception');
const results = [],
  children = [],
  sockets = [],
  httpCalls = [];
let api,
  second,
  origin,
  fixture,
  browser,
  before,
  created = false,
  connected = false;
const parent = 'https://t08.customer.test';
const pass = (label) => {
  results.push(label);
  console.info('PASS ' + label);
};
async function until(predicate, label, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await predicate()) return;
    await delay(40);
  }
  throw new Error('Timeout: ' + label);
}
async function port() {
  const s = createServer();
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const p = s.address().port;
  await new Promise((r) => s.close(r));
  return p;
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
async function start(url, enabled) {
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
        API_HOST: '127.0.0.1',
        API_PORT: new URL(url).port,
        APP_ORIGIN: origin,
        WIDGET_ORIGIN: origin,
        AI_MODE: 'fake',
        OUTBOX_ENABLED: String(enabled),
        REDIS_URL: 'redis://127.0.0.1:1',
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
    exit: null,
  };
  item.done = new Promise((r) =>
    child.once('exit', (code, signal) => {
      item.exit = { code, signal };
      r();
    }),
  );
  child.stdout.on('data', (b) => {
    item.output += b;
  });
  child.stderr.on('data', (b) => {
    item.output += b;
  });
  children.push(item);
  await until(
    async () => {
      if (item.exit) throw new Error(item.output);
      try {
        return (
          await fetch(url + '/health/live', {
            signal: AbortSignal.timeout(1000),
          })
        ).ok;
      } catch {
        return false;
      }
    },
    'API startup',
    60000,
  );
}
async function request(actor, method, path, body, status = 200, options = {}) {
  const response = await fetch((options.api ?? api) + '/api/v1' + path, {
    method,
    signal: AbortSignal.timeout(15000),
    headers: {
      Origin: origin,
      'Content-Type': 'application/json',
      'X-Requested-With': 'SmartDesk',
      'Idempotency-Key': options.key ?? randomUUID(),
      ...(actor?.token
        ? { Authorization: 'Bearer ' + actor.token }
        : actor?.cookie
          ? {
              Cookie: actor.cookie,
              ...(actor.org ? { 'X-Organization-Id': actor.org } : {}),
            }
          : {}),
      ...options.headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const value = response.status === 204 ? {} : await response.json();
  assert.ok(
    (Array.isArray(status) ? status : [status]).includes(response.status),
    `${method} ${path}: ${response.status} ${JSON.stringify(value)}`,
  );
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
      email: `${label}@t08.invalid`,
      password: 'T08-password-long-123!',
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
  Object.assign(a, { org: o.id, membershipId: o.membership.id });
  const config = (await request(a, 'GET', '/widget-config')).data;
  await request(a, 'PATCH', '/widget-config', {
    expectedVersion: config.version,
    enabled: true,
    allowedOrigins: [parent],
  });
  a.key = config.publicKey;
  return a;
}
async function join(owner, label) {
  const a = await register(label);
  const invite = (
    await request(owner, 'POST', '/invitations', { role: 'agent' }, 201)
  ).data;
  const token = new URL(invite.inviteLink).hash.slice(1);
  const result = (await request(a, 'POST', '/invitations/accept', { token }))
    .data;
  return { ...a, org: owner.org, membershipId: result.membership.id };
}
async function visitor(a) {
  const r = await request(
    null,
    'POST',
    `/public/widgets/${a.key}/bootstrap`,
    {},
    201,
    { headers: { Origin: parent } },
  );
  return { token: r.data.visitorToken, customerId: r.data.customer.id };
}
async function conversation(v) {
  return (
    await request(
      v,
      'POST',
      '/conversations',
      {
        clientConversationId: randomUUID(),
        firstMessage: { clientMessageId: randomUUID(), content: 'T08合成咨询' },
      },
      201,
    )
  ).data.conversation;
}
const detail = async (a, c) =>
  (
    await request(
      a,
      'GET',
      `/conversations/${typeof c === 'string' ? c : c.id}`,
    )
  ).data;
const command = async (a, c, type, body = {}, status = 200, options = {}) =>
  (
    await request(
      a,
      'POST',
      `/conversations/${c.id}/${type}`,
      type === 'handoff'
        ? { reason: 'customer_request', ...body }
        : { expectedVersion: c.version, ...body },
      status,
      options,
    )
  ).data;
const fact = async (c) =>
  (await db.query('SELECT * FROM conversations WHERE id=$1', [c.id ?? c]))
    .rows[0];
const member = async (a) =>
  (await db.query('SELECT * FROM memberships WHERE id=$1', [a.membershipId]))
    .rows[0];
const heartbeat = async (
  a,
  connectionId = (a.connectionId ??= randomUUID()),
  status = 200,
) => request(a, 'POST', '/presence/heartbeat', { connectionId }, status);
async function available(a) {
  await request(a, 'PATCH', '/memberships/me/availability', {
    availability: 'available',
  });
  await heartbeat(a);
}
async function changeAI(a, value) {
  const o = (await request(a, 'GET', `/organizations/${a.org}`)).data;
  return (
    await request(a, 'PATCH', `/organizations/${a.org}`, {
      expectedVersion: o.version,
      aiEnabled: value,
    })
  ).data;
}
async function connect(a) {
  const socket = io(api + '/support', {
    transports: ['websocket'],
    autoConnect: false,
    reconnection: false,
    extraHeaders: { Origin: origin, ...(a.cookie ? { Cookie: a.cookie } : {}) },
    auth: a.token ? { visitorToken: a.token } : { organizationId: a.org },
  });
  sockets.push(socket);
  const registered = a.token
    ? Promise.resolve(null)
    : new Promise((r) =>
        socket.once('presence.registered', (data) => r(data.connectionId)),
      );
  const ready = new Promise((ok, bad) => {
    socket.once('connect', ok);
    socket.once('connect_error', bad);
  });
  socket.connect();
  await ready;
  socket.presenceId = await registered;
  return socket;
}
async function ack(s, event, body, ok = true) {
  const value = await new Promise((resolve, reject) =>
    s.timeout(5000).emit(event, body, (e, v) => (e ? reject(e) : resolve(v))),
  );
  assert.equal(value.ok, ok, JSON.stringify(value));
  return value;
}
const send = (a, c, content, status = 201, id = randomUUID(), options = {}) =>
  request(
    a,
    'POST',
    `/conversations/${c.id}/messages`,
    { clientMessageId: id, content },
    status,
    options,
  );

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
  api = `http://127.0.0.1:${await port()}`;
  second = `http://127.0.0.1:${await port()}`;
  fixture = createServer((req, res) => {
    void (async () => {
      const path = new URL(req.url, 'http://fixture').pathname;
      if (path.startsWith('/api/v1/')) {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        const body = Buffer.concat(chunks),
          headers = { ...req.headers, origin };
        delete headers.host;
        delete headers['content-length'];
        httpCalls.push({
          path,
          method: req.method,
          org: req.headers['x-organization-id'],
        });
        const r = await fetch(api + req.url, {
          method: req.method,
          headers,
          body: body.length ? body : undefined,
        });
        res.statusCode = r.status;
        res.setHeader('Content-Type', 'application/json');
        res.end(Buffer.from(await r.arrayBuffer()));
      } else if (path.startsWith('/modules/')) {
        const n = path.slice(9);
        assert.ok(
          ['api', 'socket', 'message-state', 'support-client'].includes(n),
        );
        const source = await readFile(
          resolve(root, `apps/web/app/services/${n}.ts`),
          'utf8',
        );
        res.setHeader('Content-Type', 'text/javascript');
        res.end(
          ts.transpileModule(source, {
            compilerOptions: {
              target: ts.ScriptTarget.ES2022,
              module: ts.ModuleKind.ESNext,
            },
          }).outputText,
        );
      } else if (path === '/vendor.js') {
        res.setHeader('Content-Type', 'text/javascript');
        res.end(
          await readFile(
            resolve(
              root,
              'apps/web/node_modules/socket.io-client/dist/socket.io.esm.min.js',
            ),
          ),
        );
      } else {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end(
          `<title>T08实际客户端验收</title><script type="importmap">{"imports":{"socket.io-client":"/vendor.js"}}</script><script type="module">import {SupportClient} from '/modules/support-client';window.client=new SupportClient(${JSON.stringify(api)});window.ready=true;</script>`,
        );
      }
    })().catch((e) => {
      res.statusCode = 500;
      res.end(e.message);
    });
  });
  await new Promise((r) => fixture.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${fixture.address().port}`;
  await start(api, true);
  await start(second, false);
  const boss = await owner('boss'),
    other = await owner('other'),
    a = await join(boss, 'agent-a'),
    b = await join(boss, 'agent-b');
  const v = await visitor(boss),
    v2 = await visitor(boss),
    outsider = await visitor(other);
  await available(boss);
  await available(a);
  await available(b);
  await available(other);
  assert.equal((await request(boss, 'GET', '/presence')).data.length, 3);
  assert.equal(
    (
      await db.query(
        "SELECT count(*)::int n FROM presence_connections WHERE transport='socket'",
      )
    ).rows[0].n,
    0,
  );
  await heartbeat(b, a.connectionId, 403);
  await heartbeat(other, a.connectionId, 403);
  await heartbeat(v, randomUUID(), 403);
  const loginA = await request(null, 'POST', '/auth/login', {
    email: 'agent-a@t08.invalid',
    password: 'T08-password-long-123!',
  });
  const a2 = { ...a, cookie: loginA.cookie, connectionId: randomUUID() };
  await heartbeat(a2, a.connectionId, 403);
  await heartbeat(a2);
  const preference = (
    await request(a, 'PATCH', '/memberships/me/availability', {
      availability: 'away',
      readingLanguage: 'en',
    })
  ).data;
  assert.equal(preference.online, false);
  assert.equal(preference.readingLanguage, 'en');
  await available(a);
  const stale = await conversation(v);
  await db.query(
    "UPDATE presence_connections SET last_seen_at=now()-interval '61 seconds' WHERE membership_id=$1",
    [a.membershipId],
  );
  assert.equal(
    (await request(boss, 'GET', '/presence')).data.some(
      (m) => m.id === a.membershipId,
    ),
    false,
  );
  await command(a, stale, 'claim', {}, 409);
  await heartbeat(a);
  await db.query(
    "UPDATE auth_sessions SET expires_at=now()-interval '1 second' WHERE id=(SELECT auth_session_id FROM presence_connections WHERE id=$1)",
    [a2.connectionId],
  );
  await heartbeat(a2, a2.connectionId, 401);
  assert.ok(
    (await request(boss, 'GET', '/presence')).data.some(
      (m) => m.id === a.membershipId,
    ),
  );
  pass(
    'HTTP首次注册、availability与有效会话共同判定、跨成员/企业/登录会话ID重绑拒绝、超时不可认领',
  );

  // Keep authorization in flight, close the actual transport, then let registration finish.
  const blocker = new Client({ connectionString: testUrl.href });
  await blocker.connect();
  try {
    await blocker.query('BEGIN');
    await blocker.query('SELECT id FROM organizations WHERE id=$1 FOR UPDATE', [
      a.org,
    ]);
    const aborted = io(api + '/support', {
      transports: ['websocket'],
      reconnection: false,
      extraHeaders: { Origin: origin, Cookie: a.cookie },
      auth: { organizationId: a.org },
    });
    sockets.push(aborted);
    await until(
      async () =>
        (
          await db.query(
            "SELECT count(*)::int n FROM pg_stat_activity WHERE datname=$1 AND wait_event_type='Lock' AND query LIKE '%organizations%'",
            [name],
          )
        ).rows[0].n > 0,
      'handshake waiting for organization lock',
    );
    aborted.disconnect();
    await delay(100);
    await blocker.query('ROLLBACK');
    await until(
      async () =>
        (
          await db.query(
            "SELECT count(*)::int n FROM presence_connections WHERE membership_id=$1 AND transport='socket' AND disconnected_at IS NOT NULL",
            [a.membershipId],
          )
        ).rows[0].n === 1,
      'aborted handshake presence cleared',
    );
  } finally {
    await blocker.query('ROLLBACK');
    await blocker.end();
  }
  const sa = await connect(a),
    sa2 = await connect(a),
    sv = await connect(v);
  await ack(sa, 'presence.heartbeat', { connectionId: sa.presenceId });
  await ack(sa, 'presence.heartbeat', { connectionId: sa2.presenceId }, false);
  await ack(sv, 'presence.heartbeat', { connectionId: randomUUID() }, false);
  sa2.disconnect();
  await until(
    async () =>
      (
        await db.query(
          'SELECT disconnected_at FROM presence_connections WHERE id=$1',
          [sa2.presenceId],
        )
      ).rows[0].disconnected_at,
    'socket disconnect',
  );
  assert.ok(
    (await request(boss, 'GET', '/presence')).data.some(
      (m) => m.id === a.membershipId,
    ),
  );
  const privateEvents = [];
  sv.on('presence.updated', (e) => privateEvents.push(e));
  const memberEvents = [];
  sa.on('presence.updated', (e) => memberEvents.push(e));
  await request(b, 'PATCH', '/memberships/me/availability', {
    availability: 'away',
  });
  await until(
    () =>
      memberEvents.some((e) => e.data.id === b.membershipId && !e.data.online),
    'presence delivery',
  );
  assert.equal(privateEvents.length, 0);
  await available(b);
  pass(
    'Socket握手绑定、心跳ID/访客负例、多连接独立断开、presence事件只投递成员',
  );

  const c = await conversation(v),
    claimKey = randomUUID();
  const race = await Promise.all([
    request(
      a,
      'POST',
      `/conversations/${c.id}/claim`,
      { expectedVersion: c.version },
      [200, 409],
      { key: claimKey },
    ),
    request(
      b,
      'POST',
      `/conversations/${c.id}/claim`,
      { expectedVersion: c.version },
      [200, 409],
      { api: second },
    ),
  ]);
  assert.deepEqual(race.map((r) => r.status).sort(), [200, 409]);
  const winner = race[0].status === 200 ? a : b,
    loser = winner === a ? b : a;
  let claimed = race.find((r) => r.status === 200).data;
  if (winner === a) {
    assert.equal(
      (await command(a, c, 'claim', {}, 200, { key: claimKey })).version,
      claimed.version,
    );
    await command(a, { ...c, version: c.version + 1 }, 'claim', {}, 409, {
      key: claimKey,
    });
  }
  assert.equal(
    (
      await db.query(
        "SELECT count(*)::int n FROM conversation_events WHERE conversation_id=$1 AND type='claim'",
        [c.id],
      )
    ).rows[0].n,
    1,
  );
  await command(boss, c, 'assign', { membershipId: loser.membershipId }, 409);
  await command(
    loser,
    claimed,
    'assign',
    { membershipId: loser.membershipId },
    403,
  );
  await request(
    outsider,
    'POST',
    `/conversations/${c.id}/handoff`,
    { reason: 'customer_request' },
    404,
  );
  const winnerSocket = winner === a ? sa : await connect(winner);
  const humanId = randomUUID();
  await Promise.all([
    send(winner, c, '第一条人工', [200, 201], humanId),
    ack(winnerSocket, 'message.send', {
      conversationId: c.id,
      clientMessageId: humanId,
      content: '第一条人工',
    }),
  ]);
  const first = await fact(c);
  assert.ok(first.first_human_reply_at);
  assert.equal(first.first_human_reply_membership_id, winner.membershipId);
  await send(winner, c, '第一条人工', 201);
  assert.equal(
    (
      await db.query(
        "SELECT count(*)::int n FROM messages WHERE conversation_id=$1 AND sender_type='agent'",
        [c.id],
      )
    ).rows[0].n,
    2,
  );
  const transferKey = randomUUID();
  claimed = await detail(boss, c);
  const moved = await command(
    winner,
    claimed,
    'transfer',
    { membershipId: loser.membershipId, reason: '交由同事处理' },
    200,
    { key: transferKey },
  );
  assert.equal(moved.assignedMembershipId, loser.membershipId);
  await send(winner, c, '已转交不能继续发送', 404);
  await ack(
    winnerSocket,
    'message.send',
    {
      conversationId: c.id,
      clientMessageId: randomUUID(),
      content: '旧Socket发送',
    },
    false,
  );
  await command(
    winner,
    claimed,
    'transfer',
    { membershipId: loser.membershipId, reason: '交由同事处理' },
    404,
    { key: transferKey },
  );
  await send(loser, c, '接手后回复');
  assert.equal(
    (await fact(c)).first_human_reply_at.toISOString(),
    first.first_human_reply_at.toISOString(),
  );
  assert.equal(
    (await fact(c)).first_human_reply_membership_id,
    winner.membershipId,
  );
  pass(
    '双API原子认领仅一人、版本/角色/跨租户拒绝、双协议首回复只写一次、转交立即撤销旧发送权',
  );

  const ticket = randomUUID();
  await db.query(
    'INSERT INTO tickets (id,organization_id,conversation_id,customer_id,title,description,owner_membership_id,created_by_membership_id,created_command_id,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$7,$8,now())',
    [
      ticket,
      boss.org,
      c.id,
      v.customerId,
      'T08工单',
      '关闭会话不解决',
      loser.membershipId,
      randomUUID(),
    ],
  );
  const ticketBefore = (
    await db.query('SELECT * FROM tickets WHERE id=$1', [ticket])
  ).rows[0];
  let current = await detail(boss, c);
  await command(v, current, 'close', { resolution: 'agent_resolved' }, 403);
  await command(
    loser,
    current,
    'close',
    { resolution: 'customer_confirmed' },
    403,
  );
  const closeKey = randomUUID();
  let closed = await command(
    v,
    current,
    'close',
    { resolution: 'customer_confirmed' },
    200,
    { key: closeKey },
  );
  const closedFact = await fact(c);
  await command(
    v,
    current,
    'close',
    { resolution: 'customer_confirmed' },
    200,
    { key: closeKey },
  );
  assert.equal(
    (await fact(c)).closed_at.toISOString(),
    closedFact.closed_at.toISOString(),
  );
  await command(v, closed, 'handoff', {}, 409);
  await send(loser, c, '关闭不收新消息', 409);
  await command(v, closed, 'reopen', { reason: '访客冒认' }, 403);
  current = await command(loser, closed, 'reopen', { reason: '继续处理' });
  assert.equal(current.status, 'human_active');
  assert.equal(current.assignedMembershipId, loser.membershipId);
  assert.equal(current.closedAt, null);
  assert.equal(current.resolution, null);
  await changeAI(boss, true);
  assert.equal((await detail(boss, c)).status, 'human_active');
  await send(loser, c, '人工重开后回复');
  assert.equal(
    (await fact(c)).first_human_reply_at.toISOString(),
    first.first_human_reply_at.toISOString(),
  );
  assert.deepEqual(
    (await db.query('SELECT * FROM tickets WHERE id=$1', [ticket])).rows[0],
    ticketBefore,
  );
  pass(
    '按身份限制结束结果、重复关闭幂等、人工重开及开AI不回AI、首次人工事实保留、工单完全不变',
  );

  current = await detail(boss, c);
  const reads = await Promise.all([
    request(loser, 'POST', `/conversations/${c.id}/read`, {
      lastReadSeq: current.lastSeq,
    }),
    request(
      loser,
      'POST',
      `/conversations/${c.id}/read`,
      { lastReadSeq: 1 },
      200,
      { api: second },
    ),
  ]);
  assert.ok(reads.every((r) => r.data.lastReadSeq >= 1));
  assert.equal(
    (
      await request(loser, 'POST', `/conversations/${c.id}/read`, {
        lastReadSeq: 0,
      })
    ).data.lastReadSeq,
    current.lastSeq,
  );
  await request(
    loser,
    'POST',
    `/conversations/${c.id}/read`,
    { lastReadSeq: current.lastSeq + 1 },
    422,
  );
  await request(
    v,
    'POST',
    `/conversations/${c.id}/read`,
    { lastReadSeq: 1 },
    403,
  );
  await request(v, 'GET', `/conversations/${c.id}/events`, undefined, 403);
  const page = (
    await request(boss, 'GET', `/conversations/${c.id}/events?limit=1`)
  ).data;
  assert.equal(page.items.length, 1);
  assert.ok(page.nextCursor);
  assert.equal(page.items[0].commandId, undefined);
  const next = (
    await request(
      boss,
      'GET',
      `/conversations/${c.id}/events?cursor=${page.nextCursor}&limit=100`,
    )
  ).data;
  assert.ok(next.items.length >= 3);
  assert.ok(!next.items.some((e) => e.id === page.items[0].id));
  await request(
    boss,
    'GET',
    `/conversations/${stale.id}/events?cursor=${page.nextCursor}`,
    undefined,
    422,
  );
  pass('已读并发单调且不越界、内部事件分页游标绑定范围、访客不能获取内部事实');

  // Ready knowledge and queued/running tasks are controlled DB facts, never real model claims.
  const doc = randomUUID(),
    kv = randomUUID();
  await db.query(
    "INSERT INTO knowledge_documents (id,organization_id,type,created_by_membership_id,updated_at) VALUES ($1,$2,'faq',$3,now())",
    [doc, boss.org, boss.membershipId],
  );
  await db.query(
    "INSERT INTO knowledge_versions (id,organization_id,document_id,revision,title_or_question,body,content_hash,embedding_profile_version,embedding_model_id,embedding_dimensions,created_by_membership_id,preparation_status,updated_at) VALUES ($1,$2,$3,1,'测试问题','测试知识','t08','fake-v1','fake-embedding-v1',8,$4,'ready',now())",
    [kv, boss.org, doc, boss.membershipId],
  );
  await db.query(
    "UPDATE knowledge_documents SET status='enabled',current_version_id=$1 WHERE id=$2",
    [kv, doc],
  );
  const ai = await conversation(v),
    initial = await fact(ai);
  assert.equal(ai.status, 'ai_active');
  assert.ok(initial.active_ai_task_id);
  const lease = randomUUID();
  await db.query(
    "UPDATE ai_tasks SET status='running',lease_token=$1,lease_expires_at=now()+interval '20 seconds' WHERE id=$2",
    [lease, initial.active_ai_task_id],
  );
  const handoffKey = randomUUID();
  const handoffs = await Promise.all([
    command(v, ai, 'handoff', {}, 200, { key: handoffKey }),
    command(v, ai, 'handoff', {}, 200, { key: handoffKey, api: second }),
  ]);
  assert.equal(handoffs[0].version, handoffs[1].version);
  const handed = await fact(ai);
  assert.equal(handed.status, 'waiting_human');
  assert.equal(handed.first_handoff_reason, 'customer_request');
  assert.equal(handed.reception_epoch, initial.reception_epoch + 1);
  assert.equal(handed.active_ai_task_id, null);
  const task = (
    await db.query('SELECT * FROM ai_tasks WHERE id=$1', [
      initial.active_ai_task_id,
    ])
  ).rows[0];
  assert.equal(task.status, 'superseded');
  assert.equal(task.lease_token, null);
  assert.ok(task.finished_at);
  assert.equal(
    (
      await db.query(
        "UPDATE ai_tasks SET status='succeeded' WHERE id=$1 AND status='running' AND lease_token=$2 RETURNING id",
        [task.id, lease],
      )
    ).rowCount,
    0,
  );
  await command(v, ai, 'handoff');
  assert.equal(
    (await fact(ai)).first_handoff_at.toISOString(),
    handed.first_handoff_at.toISOString(),
  );
  assert.equal(
    (
      await db.query(
        "SELECT count(*)::int n FROM conversation_events WHERE conversation_id=$1 AND type='handoff'",
        [ai.id],
      )
    ).rows[0].n,
    1,
  );
  const handoffOther = await conversation(v);
  await command(v, handoffOther, 'handoff', {}, 409, { key: handoffKey });
  const direct = await conversation(v);
  await command(a, direct, 'assign', { membershipId: a.membershipId }, 403);
  const directTaken = await command(boss, direct, 'assign', {
    membershipId: a.membershipId,
  });
  const takenFact = await fact(direct);
  assert.equal(takenFact.first_handoff_reason, 'human_takeover');
  assert.equal(takenFact.active_ai_task_id, null);
  await command(v, directTaken, 'handoff');
  assert.equal((await fact(direct)).version, takenFact.version);
  pass(
    '重复转人工只产生一次首次事实/事件、同键异目标冲突、旧AI任务失效清lease、管理员直接接管AI记首次转接',
  );

  const off1 = await conversation(v),
    off2 = await conversation(v2);
  const offFirst = await fact(off1),
    offSecond = await fact(off2);
  const ticketStable = (
    await db.query('SELECT * FROM tickets WHERE id=$1', [ticket])
  ).rows[0];
  await changeAI(boss, false);
  for (const old of [offFirst, offSecond]) {
    const f = await fact(old.id);
    assert.equal(f.status, 'waiting_human');
    assert.equal(f.first_handoff_reason, 'ai_unavailable');
    assert.equal(f.reception_epoch, old.reception_epoch + 1);
    assert.equal(f.active_ai_task_id, null);
    assert.equal(
      (
        await db.query('SELECT status FROM ai_tasks WHERE id=$1', [
          old.active_ai_task_id,
        ])
      ).rows[0].status,
      'superseded',
    );
  }
  await changeAI(boss, true);
  assert.equal((await fact(off1)).status, 'waiting_human');
  assert.equal((await fact(direct)).status, 'human_active');
  assert.deepEqual(
    (await db.query('SELECT * FROM tickets WHERE id=$1', [ticket])).rows[0],
    ticketStable,
  );
  pass(
    '关闭AI在组织锁内补偿所有AI会话并失效旧任务、重新开启不复活等待或人工会话',
  );

  const earlyClosed = await conversation(v);
  const early = await command(v, earlyClosed, 'close', {
    resolution: 'unconfirmed',
  });
  assert.equal((await fact(early)).active_ai_task_id, null);
  const adminReopened = await command(boss, early, 'reopen', {
    reason: '管理员人工跟进',
  });
  assert.equal(adminReopened.status, 'human_active');
  assert.equal(adminReopened.assignedMembershipId, boss.membershipId);
  assert.equal((await fact(early)).first_handoff_reason, 'human_takeover');
  await command(
    boss,
    adminReopened,
    'transfer',
    { membershipId: other.membershipId, reason: '跨组织' },
    409,
  );
  await request(winner, 'PATCH', '/memberships/me/availability', {
    availability: 'away',
  });
  await command(
    boss,
    adminReopened,
    'transfer',
    { membershipId: winner.membershipId, reason: '离开状态' },
    409,
  );
  await available(winner);
  pass(
    'AI会话直接关闭也清理任务；管理员重开自己接管；跨组织/不可用目标转交拒绝',
  );

  await available(loser);
  const disableTarget = await fact(c),
    m = await member(loser);
  const losingSocket = await connect(loser);
  await request(boss, 'PATCH', `/memberships/${loser.membershipId}`, {
    expectedVersion: m.version,
    status: 'disabled',
  });
  const disabled = await fact(c);
  assert.equal(disabled.status, 'waiting_human');
  assert.equal(disabled.assigned_membership_id, null);
  assert.equal(disabled.reception_epoch, disableTarget.reception_epoch + 1);
  assert.equal(disabled.first_human_reply_membership_id, winner.membershipId);
  assert.equal(
    disabled.first_handoff_at.toISOString(),
    first.first_handoff_at.toISOString(),
  );
  await send(loser, c, '停用发送', 404);
  await heartbeat(loser, loser.connectionId, 404);
  await until(() => !losingSocket.connected, 'disabled Socket disconnected');
  await request(
    loser,
    'PATCH',
    '/memberships/me/availability',
    {
      availability: 'available',
    },
    403,
  );
  assert.equal(
    (await request(boss, 'GET', '/presence')).data.some(
      (m) => m.id === loser.membershipId,
    ),
    false,
  );
  assert.deepEqual(
    (await db.query('SELECT * FROM tickets WHERE id=$1', [ticket])).rows[0],
    ticketBefore,
  );
  const bossMember = await member(boss);
  await request(
    boss,
    'PATCH',
    `/memberships/${boss.membershipId}`,
    { expectedVersion: bossMember.version, status: 'disabled' },
    409,
  );
  pass(
    '停用成员补偿在服会话、保留首次事实与工单、HTTP/Socket立即撤权、最后管理员保护',
  );

  // A database failure must roll back every state, task, event and receipt effect.
  const rollbackChat = await conversation(v),
    beforeFailure = await fact(rollbackChat),
    rollbackKey = randomUUID();
  await db.query(
    "CREATE FUNCTION t08_fail_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'T08 controlled transaction failure'; END $$",
  );
  await db.query(
    'CREATE TRIGGER t08_fail BEFORE INSERT ON conversation_events FOR EACH ROW EXECUTE FUNCTION t08_fail_event()',
  );
  await command(v, rollbackChat, 'handoff', {}, 503, { key: rollbackKey });
  assert.deepEqual(await fact(rollbackChat), beforeFailure);
  assert.equal(
    (
      await db.query('SELECT status FROM ai_tasks WHERE id=$1', [
        beforeFailure.active_ai_task_id,
      ])
    ).rows[0].status,
    'queued',
  );
  assert.equal(
    (
      await db.query(
        'SELECT count(*)::int n FROM operation_receipts WHERE command_id=$1',
        [rollbackKey],
      )
    ).rows[0].n,
    0,
  );
  await db.query('DROP TRIGGER t08_fail ON conversation_events');
  await command(v, rollbackChat, 'handoff', {}, 200, { key: rollbackKey });
  pass('真实数据库失败回滚状态/AI任务/事件/收据，原幂等键可重试');

  const raceChat = await command(boss, await conversation(v), 'assign', {
    membershipId: winner.membershipId,
  });
  const raceMember = await member(winner),
    raceMessageId = randomUUID();
  const competing = await Promise.all([
    request(boss, 'PATCH', `/memberships/${winner.membershipId}`, {
      expectedVersion: raceMember.version,
      status: 'disabled',
    }),
    send(winner, raceChat, '与停用并发的回复', [201, 404], raceMessageId, {
      api: second,
    }),
  ]);
  const afterRace = await fact(raceChat);
  assert.equal(afterRace.status, 'waiting_human');
  assert.equal(afterRace.assigned_membership_id, null);
  assert.equal(
    (
      await db.query(
        'SELECT count(*)::int n FROM messages WHERE client_message_id=$1',
        [raceMessageId],
      )
    ).rows[0].n,
    competing[1].status === 201 ? 1 : 0,
  );
  await send(winner, raceChat, '停用已提交之后', 404);
  const disabledWinner = await member(winner);
  await request(boss, 'PATCH', `/memberships/${winner.membershipId}`, {
    expectedVersion: disabledWinner.version,
    status: 'active',
  });
  await available(winner);
  pass(
    '跨API停用与发送竞争按组织锁裁决；提交后的新发送拒绝，无丢失或重复业务效果',
  );

  // Test the shipped client with all Socket traffic blocked from the first load.
  const browserActor = await join(boss, 'browser-agent');
  await request(browserActor, 'PATCH', '/memberships/me/availability', {
    availability: 'available',
  });
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  await context.route('**/socket.io/**', (route) => route.abort());
  await context.addCookies([
    {
      name: 'smartdesk_session',
      value: browserActor.cookie.split('=')[1],
      url: origin,
    },
  ]);
  const pageBrowser = await context.newPage();
  await pageBrowser.goto(origin);
  await pageBrowser.waitForFunction(() => window.ready);
  await pageBrowser.evaluate(
    (a) =>
      window.client.setIdentity({
        kind: 'member',
        userId: a.userId,
        organizationId: a.org,
        membershipId: a.membershipId,
      }),
    browserActor,
  );
  await until(
    async () =>
      (await request(boss, 'GET', '/presence')).data.some(
        (m) => m.id === browserActor.membershipId,
      ),
    'HTTP first browser heartbeat',
  );
  assert.equal(
    (
      await db.query(
        "SELECT count(*)::int n FROM presence_connections WHERE membership_id=$1 AND transport='socket'",
        [browserActor.membershipId],
      )
    ).rows[0].n,
    0,
  );
  await pageBrowser.evaluate(() => window.client.setVisible(false));
  const count = httpCalls.filter(
    (c) => c.path === '/api/v1/presence/heartbeat',
  ).length;
  await pageBrowser.clock.install();
  await pageBrowser.clock.fastForward(31000);
  assert.equal(
    httpCalls.filter((c) => c.path === '/api/v1/presence/heartbeat').length,
    count,
  );
  await pageBrowser.evaluate(() => window.client.setVisible(true));
  await until(
    () =>
      httpCalls.filter((c) => c.path === '/api/v1/presence/heartbeat').length >
      count,
    'visible heartbeat',
  );
  await pageBrowser.evaluate(() => window.client.destroy());
  const afterDestroy = httpCalls.filter(
    (c) => c.path === '/api/v1/presence/heartbeat',
  ).length;
  await pageBrowser.clock.fastForward(31000);
  assert.equal(
    httpCalls.filter((c) => c.path === '/api/v1/presence/heartbeat').length,
    afterDestroy,
  );
  await request(browserActor, 'POST', '/auth/logout', {}, 204);
  await heartbeat(browserActor, randomUUID(), 401);
  assert.equal(
    (await request(boss, 'GET', '/presence')).data.some(
      (m) => m.id === browserActor.membershipId,
    ),
    false,
  );
  await pageBrowser.screenshot({
    path: resolve(evidence, 'http-first-presence.png'),
  });
  pass(
    'Chromium实际SupportClient：从未连上Socket也能首次HTTP在线、隐藏暂停/恢复/销毁、登出失效',
  );
  const archive = resolve(root, 'tests/integration/reception-api.mjs');
  const probe = spawnSync(process.execPath, [archive], {
    cwd: root,
    windowsHide: true,
    encoding: 'utf8',
    env: {
      ...process.env,
      API_BASE_URL: api,
      APP_ORIGIN: origin,
      T08_FIXTURE: JSON.stringify({ boss, agent: winner, visitor: v }),
    },
  });
  await writeFile(
    resolve(evidence, 'api-verification.log'),
    probe.stdout + probe.stderr,
  );
  assert.equal(probe.status, 0, probe.stdout + probe.stderr);
  pass('归档API脚本连接现有隔离实例：11接口及持久化读回通过');
  await writeFile(
    resolve(evidence, 'results.json'),
    JSON.stringify(
      {
        result: 'PASS',
        scenarios: results,
        modelCalls: 0,
        isolatedDatabase: name,
        api,
        second,
        origin,
      },
      null,
      2,
    ),
  );
} finally {
  await browser?.close();
  for (const s of sockets) s.disconnect();
  for (const item of children.reverse()) {
    if (!item.exit) item.child.kill();
    await item.done;
    await writeFile(resolve(evidence, `api-${item.pid}.log`), item.output);
    console.info(
      JSON.stringify({
        stopped: item.pid,
        url: item.url,
        command: item.command,
        cwd: item.cwd,
        exit: item.exit,
      }),
    );
    await assert.rejects(() => fetch(item.url + '/health/live'));
  }
  if (fixture) await new Promise((r) => fixture.close(r));
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
