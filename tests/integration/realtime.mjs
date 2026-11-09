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
const { Queue, Worker } = require('bullmq');
const base = new URL(process.env.DATABASE_URL);
assert.ok(['localhost', '127.0.0.1'].includes(base.hostname));
const name = `smartdesk_t06_${process.pid}_${Date.now()}`;
const container = `smartdesk-t06-${process.pid}-${Date.now()}`;
const adminUrl = new URL(base);
adminUrl.pathname = '/postgres';
const testUrl = new URL(base);
testUrl.pathname = '/' + name;
const admin = new Client({ connectionString: adminUrl.href });
const main = new Client({ connectionString: base.href });
const db = new Client({ connectionString: testUrl.href });
const evidence = resolve(root, 'test-results/realtime');
const results = [],
  children = [],
  sockets = [];
let browser,
  fixture,
  prisma,
  queue,
  worker,
  publisher,
  initial,
  created = false,
  redisStarted = false,
  connected = false;
let api, origin, current;
const parent = 'https://t06.customer.test';
const pass = (label) => {
  results.push(label);
  console.info('PASS ' + label);
};
async function until(predicate, label, ms = 12000) {
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
function docker(...args) {
  const r = spawnSync('docker', args, {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30000,
  });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  return r.stdout.trim();
}
async function snapshot() {
  const data = {};
  const tables = (
    await main.query(
      "SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename<>'_prisma_migrations' ORDER BY tablename",
    )
  ).rows;
  for (const { tablename } of tables) {
    assert.match(tablename, /^[a-z_]+$/);
    data[tablename] = (
      await main.query(
        `SELECT count(*)::int count, md5(coalesce(string_agg(to_jsonb(t)::text,'' ORDER BY to_jsonb(t)::text),'')) digest FROM "${tablename}" t`,
      )
    ).rows[0];
  }
  return data;
}
async function start(enabled = true, leaseMs = 1000) {
  const p = Number(new URL(api).port);
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
        API_PORT: String(p),
        APP_ORIGIN: origin,
        WIDGET_ORIGIN: origin,
        OUTBOX_ENABLED: String(enabled),
        OUTBOX_POLL_MS: '250',
        OUTBOX_LEASE_MS: String(leaseMs),
        AI_MODE: 'fake',
      },
    },
  );
  const item = {
    child,
    pid: child.pid,
    port: p,
    command: 'node apps/server/dist/main.js',
    cwd: root,
    enabled,
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
          await fetch(api + '/health/live', {
            signal: AbortSignal.timeout(1000),
          })
        ).ok;
      } catch {
        return false;
      }
    },
    'API start',
    60000,
  );
  current = item;
  return item;
}
async function stop(item = current) {
  if (!item.exit) item.child.kill();
  await item.done;
  await until(async () => {
    try {
      await fetch(api + '/health/live');
      return false;
    } catch {
      return true;
    }
  }, 'API stop');
}
async function request(actor, method, path, body, status = 200, headers = {}) {
  const r = await fetch(api + '/api/v1' + path, {
    method,
    signal: AbortSignal.timeout(10000),
    headers: {
      Origin: origin,
      'Content-Type': 'application/json',
      'X-Requested-With': 'SmartDesk',
      'Idempotency-Key': randomUUID(),
      ...(actor?.token
        ? { Authorization: 'Bearer ' + actor.token }
        : actor?.cookie
          ? {
              Cookie: actor.cookie,
              ...(actor.org ? { 'X-Organization-Id': actor.org } : {}),
            }
          : {}),
      ...headers,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const value = r.status === 204 ? {} : await r.json();
  assert.ok(
    (Array.isArray(status) ? status : [status]).includes(r.status),
    `HTTP ${r.status}: ${JSON.stringify(value)}`,
  );
  return { ...value, cookie: r.headers.get('set-cookie')?.split(';')[0] };
}
async function owner(label) {
  const registered = await request(
    null,
    'POST',
    '/auth/register',
    {
      email: `${label}@t06.invalid`,
      password: 'T06-password-long-123!',
      displayName: label,
    },
    201,
  );
  const actor = { cookie: registered.cookie };
  actor.org = (
    await request(actor, 'POST', '/organizations', { name: label }, 201)
  ).data.id;
  const config = (await request(actor, 'GET', '/widget-config')).data;
  await request(actor, 'PATCH', '/widget-config', {
    expectedVersion: config.version,
    enabled: true,
    allowedOrigins: [parent],
  });
  actor.key = config.publicKey;
  return actor;
}
async function visitor(actor) {
  const b = (
    await request(
      null,
      'POST',
      `/public/widgets/${actor.key}/bootstrap`,
      {},
      201,
      { Origin: parent },
    )
  ).data;
  return { token: b.visitorToken, customer: b.customer };
}
async function conversation(actor, content = 'T06 synthetic first message') {
  return (
    await request(
      actor,
      'POST',
      '/conversations',
      {
        clientConversationId: randomUUID(),
        firstMessage: { clientMessageId: randomUUID(), content },
      },
      201,
    )
  ).data;
}
async function connect(actor, options = {}) {
  const s = io(api + '/support', {
    transports: ['websocket'],
    reconnection: false,
    timeout: 3000,
    extraHeaders: {
      Origin: origin,
      ...(actor.cookie ? { Cookie: actor.cookie } : {}),
      ...options.headers,
    },
    auth: actor.token
      ? { visitorToken: actor.token }
      : { organizationId: actor.org },
    ...options,
  });
  sockets.push(s);
  await new Promise((ok, bad) => {
    s.once('connect', ok);
    s.once('connect_error', bad);
  });
  return s;
}
async function ack(socket, event, body, ok = true) {
  const r = await socket.timeout(4000).emitWithAck(event, body);
  assert.equal(r.ok, ok, JSON.stringify(r));
  assert.ok(r.requestId);
  return r;
}
const send = (s, cid, content, clientMessageId = randomUUID()) =>
  ack(s, 'message.send', { conversationId: cid, clientMessageId, content });
try {
  await mkdir(evidence, { recursive: true });
  await admin.connect();
  await main.connect();
  initial = await snapshot();
  await writeFile(
    resolve(evidence, 'main-before.json'),
    JSON.stringify(initial),
  );
  await admin.query(`CREATE DATABASE "${name}"`);
  created = true;
  const migration = spawnSync(
    process.execPath,
    [resolve(root, 'node_modules/prisma/build/index.js'), 'migrate', 'deploy'],
    {
      cwd: root,
      env: { ...process.env, DATABASE_URL: testUrl.href },
      encoding: 'utf8',
      windowsHide: true,
    },
  );
  await writeFile(
    resolve(evidence, 'migration.log'),
    migration.stdout + migration.stderr,
  );
  assert.equal(migration.status, 0);
  await db.connect();
  connected = true;
  const redisPort = await port();
  const image = (await readFile(resolve(root, 'compose.yaml'), 'utf8')).match(
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
    'redis-server',
    '--appendonly',
    'yes',
    '--maxmemory-policy',
    'noeviction',
  );
  redisStarted = true;
  process.env.REDIS_URL = `redis://127.0.0.1:${redisPort}`;
  process.env.DATABASE_URL = testUrl.href;
  const bundle = await readFile(
    resolve(
      root,
      'apps/server/node_modules/socket.io-client/dist/socket.io.js',
    ),
  );
  fixture = createServer((req, res) => {
    res.setHeader(
      'Content-Type',
      req.url === '/client.js' ? 'text/javascript' : 'text/html',
    );
    res.end(
      req.url === '/client.js'
        ? bundle
        : '<!doctype html><title>T06 isolated transport verification</title>',
    );
  });
  await new Promise((r) => fixture.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${fixture.address().port}`;
  api = `http://127.0.0.1:${await port()}`;
  prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: testUrl.href }),
  });
  const { Outbox, TaskPublisher } = require(
    resolve(root, 'apps/server/dist/modules/realtime/outbox.js'),
  );
  await start(false);
  const adminA = await owner('owner-a'),
    adminB = await owner('owner-b');
  const va = await visitor(adminA),
    vb = await visitor(adminA),
    other = await visitor(adminB);
  const c = await conversation(va),
    cid = c.conversation.id;
  const sa = await connect(va);
  await connect(adminA);
  const snap = (
    await ack(sa, 'conversation.subscribe', { conversationId: cid })
  ).data;
  assert.equal(snap.snapshotThroughSeq, 1);
  assert.equal(snap.conversationVersion, c.message.conversationVersion);
  const wrong = await connect(other);
  assert.equal(
    (await ack(wrong, 'conversation.subscribe', { conversationId: cid }, false))
      .error.code,
    'NOT_FOUND',
  );
  const sibling = await connect(vb);
  await ack(sibling, 'conversation.subscribe', { conversationId: cid }, false);
  await assert.rejects(
    connect(va, { headers: { Origin: 'https://forbidden.test' } }),
  );
  await assert.rejects(
    connect(va, {
      auth: { visitorToken: va.token, organizationId: adminA.org },
    }),
  );
  await assert.rejects(connect(va, { query: { visitorToken: va.token } }));
  await ack(
    sa,
    'conversation.subscribe',
    { conversationId: cid, room: 'all' },
    false,
  );
  await ack(sa, 'presence.heartbeat', { connectionId: randomUUID() }, false);
  pass(
    'handshake Origin and identity separation, forbidden room/tenant/customer, subscription watermark',
  );

  const mid = randomUUID();
  const concurrent = await Promise.all([
    send(sa, cid, 'same HTTP and Socket', mid),
    request(
      va,
      'POST',
      `/conversations/${cid}/messages`,
      { clientMessageId: mid, content: 'same HTTP and Socket' },
      [200, 201],
    ),
  ]);
  assert.equal(concurrent[0].data.id, concurrent[1].data.id);
  const conflict = await ack(
    sa,
    'message.send',
    { conversationId: cid, clientMessageId: mid, content: 'different' },
    false,
  );
  assert.equal(conflict.error.code, 'IDEMPOTENCY_CONFLICT');
  const forged = await ack(
    sa,
    'message.send',
    {
      conversationId: cid,
      clientMessageId: randomUUID(),
      content: 'forged',
      senderId: adminA.org,
    },
    false,
  );
  assert.equal(forged.error.code, 'INVALID_INPUT');
  await db.query(
    "CREATE FUNCTION t06_fail_message() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'T06 fault'; END $$; CREATE TRIGGER t06_message_fail BEFORE INSERT ON messages FOR EACH ROW EXECUTE FUNCTION t06_fail_message()",
  );
  assert.equal(
    (
      await ack(
        sa,
        'message.send',
        {
          conversationId: cid,
          clientMessageId: randomUUID(),
          content: 'must rollback',
        },
        false,
      )
    ).error.code,
    'SERVICE_UNAVAILABLE',
  );
  await db.query(
    'DROP TRIGGER t06_message_fail ON messages; DROP FUNCTION t06_fail_message()',
  );
  pass(
    'HTTP and Socket share canonical idempotency, conflict and forged sender rejection; DB failure has no success ACK',
  );

  const outbox = new Outbox(prisma, 600);
  const claims = await Promise.all([
    outbox.claim('socket'),
    outbox.claim('socket'),
  ]);
  const all = claims.flat();
  assert.equal(new Set(all.map((x) => x.id)).size, all.length);
  assert.ok(all.length >= 4);
  const leased = all[0];
  await delay(650);
  const reclaimed = (await outbox.claim('socket')).find(
    (x) => x.id === leased.id,
  );
  assert.ok(reclaimed);
  assert.equal(await outbox.finish(leased, true), 0);
  assert.equal(await outbox.finish(reclaimed, false), 1);
  pass(
    'real database competing claims, expired lease recovery, stale token cannot acknowledge',
  );
  await stop();
  await start(true);
  const receiver = await connect(adminA);
  await ack(receiver, 'conversation.subscribe', { conversationId: cid });
  await until(
    async () =>
      (
        await db.query(
          "SELECT count(*)::int n FROM outbox_events WHERE destination='socket' AND status='pending'",
        )
      ).rows[0].n === 0,
    'restart pending outbox',
  );
  const history = (
    await request(va, 'GET', `/conversations/${cid}/messages?afterSeq=1`)
  ).data;
  assert.equal(history.items.length, 1);
  pass(
    'saved messages survive API exit and pending outbox resumes; offline history recovers contiguous seq',
  );

  const sender = await connect(va);
  await ack(sender, 'conversation.subscribe', { conversationId: cid });
  const received = [];
  receiver.on('message.created', (e) => received.push(e));
  const noAck = randomUUID();
  sender.emit('message.send', {
    conversationId: cid,
    clientMessageId: noAck,
    content: 'lost client ACK',
  });
  await until(
    () => received.some((e) => e.data.clientMessageId === noAck),
    'broadcast without callback',
  );
  const result = (
    await request(va, 'GET', `/conversations/${cid}/message-requests/${noAck}`)
  ).data;
  const replay = (
    await request(va, 'POST', `/conversations/${cid}/messages`, {
      clientMessageId: noAck,
      content: 'lost client ACK',
    })
  ).data;
  assert.deepEqual(result, replay);
  const event = received.find((e) => e.data.id === result.id);
  await db.query(
    "UPDATE outbox_events SET status='pending',published_at=NULL,available_at=now(),lease_token=NULL,lease_expires_at=NULL WHERE id=$1",
    [event.eventId],
  );
  await until(
    () => received.filter((e) => e.eventId === event.eventId).length >= 2,
    'duplicate event',
  );
  assert.equal(
    (
      await db.query('SELECT count(*)::int n FROM messages WHERE id=$1', [
        result.id,
      ])
    ).rows[0].n,
    1,
  );
  assert.deepEqual(
    received.filter((e) => e.eventId === event.eventId)[0],
    received.filter((e) => e.eventId === event.eventId)[1],
  );
  pass(
    'ACK absent, broadcast confirms commit, HTTP lookup/retry returns same message; duplicate event has no duplicate business effect',
  );

  // Delay only delivery of the real ACK to this client, without a production test switch.
  const handleAck = sender.onack.bind(sender);
  let releaseAck,
    ackObserved = false;
  sender.onack = (packet) => {
    releaseAck = () => handleAck(packet);
  };
  const reorderedId = randomUUID();
  const delayedAck = send(
    sender,
    cid,
    'broadcast before client ACK',
    reorderedId,
  ).then((r) => {
    ackObserved = true;
    return r;
  });
  await until(
    () =>
      received.some((e) => e.data.clientMessageId === reorderedId) &&
      releaseAck,
    'broadcast before delayed ACK',
  );
  assert.equal(ackObserved, false);
  releaseAck();
  const reordered = await delayedAck;
  sender.onack = handleAck;
  assert.deepEqual(
    received.find((e) => e.data.clientMessageId === reorderedId).data,
    reordered.data,
  );
  pass(
    'controlled ACK receive delay: real broadcast arrives first with the same committed canonical message',
  );

  await db.query(
    "CREATE FUNCTION t06_mark_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.status='published' OR (OLD.lease_token IS NOT NULL AND NEW.lease_token IS NULL) THEN RAISE EXCEPTION 'publish bookkeeping fault'; END IF; RETURN NEW; END $$; CREATE TRIGGER t06_mark_fail BEFORE UPDATE ON outbox_events FOR EACH ROW EXECUTE FUNCTION t06_mark_fault()",
  );
  const crash = await send(sender, cid, 'published before process crash');
  await until(
    () => received.some((e) => e.data.id === crash.data.id),
    'publish reached socket',
  );
  const crashEvent = received.find((e) => e.data.id === crash.data.id);
  assert.equal(
    (
      await db.query('SELECT status FROM outbox_events WHERE id=$1', [
        crashEvent.eventId,
      ])
    ).rows[0].status,
    'pending',
  );
  await stop();
  await db.query(
    'DROP TRIGGER t06_mark_fail ON outbox_events; DROP FUNCTION t06_mark_fault()',
  );
  await start(true);
  let restored = await connect(va);
  await ack(restored, 'conversation.subscribe', { conversationId: cid });
  await until(
    async () =>
      (
        await db.query('SELECT status FROM outbox_events WHERE id=$1', [
          crashEvent.eventId,
        ])
      ).rows[0].status === 'published',
    'replayed after crash',
  );
  assert.deepEqual(
    (
      await request(
        va,
        'GET',
        `/conversations/${cid}/message-requests/${crash.data.clientMessageId}`,
      )
    ).data,
    crash.data,
  );
  pass(
    'published-but-unmarked process crash recovers original event, leaves business message unchanged',
  );

  const adminMember = (
    await db.query('SELECT id FROM memberships WHERE organization_id=$1', [
      adminA.org,
    ])
  ).rows[0].id;
  const kd = randomUUID(),
    kv = randomUUID();
  await db.query('UPDATE organizations SET ai_enabled=true WHERE id=$1', [
    adminA.org,
  ]);
  await db.query(
    "INSERT INTO knowledge_documents(id,organization_id,type,created_by_membership_id,updated_at) VALUES($1,$2,'faq',$3,now())",
    [kd, adminA.org, adminMember],
  );
  await db.query(
    "INSERT INTO knowledge_versions(id,organization_id,document_id,revision,title_or_question,body,content_hash,embedding_profile_version,embedding_model_id,embedding_dimensions,created_by_membership_id,preparation_status,updated_at) VALUES($1,$2,$3,1,'synthetic','synthetic','fixture','fake-v1','fake-embedding-v1',8,$4,'ready',now())",
    [kv, adminA.org, kd, adminMember],
  );
  await db.query(
    "UPDATE knowledge_documents SET current_version_id=$2,status='enabled' WHERE id=$1",
    [kd, kv],
  );
  docker('stop', container);
  const queueConversation = await conversation(va);
  const taskId = (
    await db.query('SELECT id FROM ai_tasks WHERE conversation_id=$1', [
      queueConversation.conversation.id,
    ])
  ).rows[0].id;
  await delay(500);
  assert.equal(
    (
      await db.query(
        "SELECT status FROM outbox_events WHERE destination='queue' AND aggregate_id=$1",
        [taskId],
      )
    ).rows[0].status,
    'pending',
  );
  const duringFailure = await request(
    va,
    'POST',
    `/conversations/${cid}/messages`,
    { clientMessageId: randomUUID(), content: 'HTTP during Redis outage' },
    201,
  );
  assert.ok(
    (
      await request(
        va,
        'GET',
        `/conversations/${cid}/messages?afterSeq=${duringFailure.data.seq - 1}`,
      )
    ).data.items.some((x) => x.id === duringFailure.data.id),
  );
  const outageEvents = [];
  restored.on('message.created', (e) => outageEvents.push(e));
  const socketDuringFailure = await send(
    restored,
    cid,
    'Socket during Redis outage',
  );
  await until(
    () => outageEvents.some((e) => e.data.id === socketDuringFailure.data.id),
    'local Socket delivery during Redis outage',
  );
  docker('start', container);
  queue = new Queue('ai-tasks', {
    prefix: 'smartdesk',
    connection: { url: process.env.REDIS_URL },
  });
  queue.on('error', () => undefined);
  await until(
    async () => Boolean(await queue.getJob(taskId)),
    'queue recovery',
    10000,
  );
  assert.deepEqual((await queue.getJob(taskId)).data, { taskId });
  publisher = new TaskPublisher(prisma);
  const queueEvent = await prisma.outboxEvent.findFirst({
    where: { aggregateId: taskId, destination: 'queue' },
  });
  await publisher.publish(queueEvent);
  await publisher.publish(queueEvent);
  let consumed = 0;
  worker = new Worker(
    'ai-tasks',
    async (job) => {
      assert.deepEqual(Object.keys(job.data), ['taskId']);
      consumed++;
      return { transportVerified: true };
    },
    { prefix: 'smartdesk', connection: { url: process.env.REDIS_URL } },
  );
  worker.on('error', () => undefined);
  await until(
    async () => (await queue.getJob(taskId)).isCompleted(),
    'real queue consumer',
  );
  await publisher.publish(queueEvent);
  await delay(150);
  assert.equal(consumed, 1);
  assert.equal(
    (await db.query('SELECT status FROM ai_tasks WHERE id=$1', [taskId]))
      .rows[0].status,
    'queued',
  );
  pass(
    'isolated Redis outage preserves HTTP writes/history and local Socket delivery; reconnect enqueues ID-only stable job; test worker consumes once without fabricating AI outcome',
  );

  const originalTask = await prisma.aiTask.findUnique({
    where: { id: taskId },
  });
  for (const status of ['queued', 'succeeded', 'failed', 'superseded']) {
    const t = await prisma.aiTask.create({
      data: {
        ...originalTask,
        id: randomUUID(),
        inputRevision:
          originalTask.inputRevision +
          10 +
          ['queued', 'succeeded', 'failed', 'superseded'].indexOf(status),
        status,
        deadlineAt:
          status === 'queued'
            ? new Date(Date.now() - 1000)
            : new Date(Date.now() + 60000),
      },
    });
    await publisher.publish({ ...queueEvent, aggregateId: t.id });
    assert.equal(await queue.getJob(t.id), undefined);
    assert.equal(
      (await prisma.aiTask.findUnique({ where: { id: t.id } })).status,
      status,
    );
  }
  const unknown = await prisma.outboxEvent.create({
    data: {
      organizationId: adminA.org,
      aggregateType: 'unknown',
      aggregateId: randomUUID(),
      aggregateVersion: 0,
      destination: 'queue',
      eventType: 'unsupported.future',
      payload: {},
    },
  });
  await until(
    async () =>
      (await prisma.outboxEvent.findUnique({ where: { id: unknown.id } }))
        .attemptCount > 0,
    'unknown event attempted',
  );
  assert.equal(
    (await prisma.outboxEvent.findUnique({ where: { id: unknown.id } })).status,
    'pending',
  );
  pass(
    'expired and terminal AI tasks are not re-enqueued or reactivated; unsupported queue events remain pending',
  );

  // Measure the shipping defaults, separate from shortened crash-recovery leases.
  await stop();
  await start(true, 30000);
  restored = await connect(va);
  await ack(restored, 'conversation.subscribe', { conversationId: cid });
  browser = await chromium.launch({ headless: true });
  const memberContext = await browser.newContext();
  await memberContext.addCookies([
    {
      name: 'smartdesk_session',
      value: adminA.cookie.split('=')[1],
      url: origin,
    },
  ]);
  const visitorContext = await browser.newContext();
  const memberPage = await memberContext.newPage(),
    visitorPage = await visitorContext.newPage();
  for (const page of [memberPage, visitorPage]) {
    await page.goto(origin);
    await page.addScriptTag({ url: origin + '/client.js' });
  }
  async function browserConnect(page, auth) {
    await page.evaluate(
      async ({ api, auth, cid }) => {
        window.events = [];
        window.socket = window.io(api + '/support', {
          auth,
          withCredentials: true,
          transports: ['websocket'],
          reconnection: false,
        });
        await new Promise((r, e) => {
          window.socket.once('connect', r);
          window.socket.once('connect_error', e);
        });
        window.socket.on('message.created', (e) =>
          window.events.push({ ...e, receivedAt: Date.now() }),
        );
        const response = await window.socket
          .timeout(3000)
          .emitWithAck('conversation.subscribe', { conversationId: cid });
        if (!response.ok) throw new Error(JSON.stringify(response));
      },
      { api, auth, cid },
    );
  }
  await browserConnect(memberPage, { organizationId: adminA.org });
  await browserConnect(visitorPage, { visitorToken: va.token });
  const samples = await visitorPage.evaluate(async (cid) => {
    const samples = [];
    for (let i = 0; i < 100; i++) {
      const startedAt = Date.now();
      const response = await window.socket
        .timeout(5000)
        .emitWithAck('message.send', {
          conversationId: cid,
          clientMessageId: crypto.randomUUID(),
          content: `browser transport ${i}`,
        });
      if (!response.ok) throw new Error(JSON.stringify(response));
      samples.push({ id: response.data.id, seq: response.data.seq, startedAt });
    }
    return samples;
  }, cid);
  await until(
    async () =>
      memberPage.evaluate(
        (ids) => ids.every((id) => window.events.some((e) => e.data.id === id)),
        samples.map((s) => s.id),
      ),
    'all 100 distinct browser deliveries',
    30000,
  );
  const browserEvents = await memberPage.evaluate(() => window.events);
  const latency = samples
    .map(
      (s) =>
        browserEvents.find((e) => e.data.id === s.id).receivedAt - s.startedAt,
    )
    .sort((a, b) => a - b);
  assert.ok(latency[94] <= 2000, `p95=${latency[94]}`);
  await writeFile(
    resolve(evidence, 'browser.json'),
    JSON.stringify({
      samples: 100,
      outboxPollMs: 250,
      outboxLeaseMs: 30000,
      p95Ms: latency[94],
      maxMs: latency[99],
      origins: { page: origin, api },
      contexts: 2,
      modelCalls: 0,
    }),
  );
  await memberPage.screenshot({ path: resolve(evidence, 'browser.png') });
  pass(
    'real Chromium member Cookie and visitor Bearer contexts: 100 messages, p95 <= 2 seconds',
  );

  const updates = [];
  restored.onAny((type, event) => updates.push({ type, event }));
  await prisma.conversationNote.create({
    data: {
      organizationId: adminA.org,
      conversationId: cid,
      authorMembershipId: adminMember,
      clientNoteId: randomUUID(),
      content: 'T06_INTERNAL_NOTE_NEVER_PUBLIC',
    },
  });
  const statusId = randomUUID();
  await prisma.outboxEvent.create({
    data: {
      id: statusId,
      organizationId: adminA.org,
      aggregateType: 'knowledge',
      aggregateId: kd,
      aggregateVersion: 99,
      eventType: 'knowledge.updated',
      destination: 'socket',
      payload: { secret: 'must never appear' },
    },
  });
  await until(
    async () =>
      (await prisma.outboxEvent.findUnique({ where: { id: statusId } }))
        .status === 'published',
    'private notification',
  );
  assert.ok(!updates.some((x) => x.type === 'knowledge.updated'));
  const conversationNotice = randomUUID();
  await prisma.outboxEvent.create({
    data: {
      id: conversationNotice,
      organizationId: adminA.org,
      aggregateType: 'conversation',
      aggregateId: cid,
      aggregateVersion: 999,
      eventType: 'conversation.updated',
      destination: 'socket',
      payload: { secret: 'private', data: { notes: 'private' } },
    },
  });
  await until(
    () => updates.some((x) => x.event.eventId === conversationNotice),
    'safe conversation projection',
  );
  const publicData = updates.find((x) => x.event.eventId === conversationNotice)
    .event.data;
  assert.equal(publicData.assignedMembershipId, undefined);
  assert.equal(publicData.notes, undefined);
  assert.equal(publicData.secret, undefined);
  await ack(restored, 'conversation.unsubscribe', { conversationId: cid });
  await ack(restored, 'conversation.unsubscribe', { conversationId: cid });
  assert.ok(
    !JSON.stringify(
      (await request(va, 'GET', `/conversations/${cid}/messages`)).data,
    ).includes('T06_INTERNAL_NOTE_NEVER_PUBLIC'),
  );
  pass(
    'private event withheld from visitor; conversation public projection ignores malicious payload; unsubscribe is idempotent',
  );

  const invite = (
    await request(adminA, 'POST', '/invitations', { role: 'agent' }, 201)
  ).data;
  const accepted = (
    await request(adminB, 'POST', '/invitations/accept', {
      token: new URL(invite.inviteLink).hash.slice(1),
    })
  ).data;
  const agent = { cookie: adminB.cookie, org: adminA.org },
    agentMember = accepted.membership.id;
  const agentSocket = await connect(agent),
    agentEvents = [];
  agentSocket.on('message.created', (e) => agentEvents.push(e));
  await ack(agentSocket, 'conversation.subscribe', { conversationId: cid });
  await db.query(
    "UPDATE conversations SET status='human_active',assigned_membership_id=$2,version=version+1 WHERE id=$1",
    [cid, agentMember],
  );
  await send(agentSocket, cid, 'assigned agent can reply');
  await db.query(
    'UPDATE conversations SET assigned_membership_id=$2,version=version+1 WHERE id=$1',
    [cid, adminMember],
  );
  await ack(
    agentSocket,
    'message.send',
    {
      conversationId: cid,
      clientMessageId: randomUUID(),
      content: 'former assignee must fail',
    },
    false,
  );
  await ack(
    agentSocket,
    'conversation.subscribe',
    { conversationId: cid },
    false,
  );
  const privateReply = (
    await request(
      adminA,
      'POST',
      `/conversations/${cid}/messages`,
      {
        clientMessageId: randomUUID(),
        content: 'restricted after reassignment',
      },
      201,
    )
  ).data;
  await until(
    async () =>
      (
        await prisma.outboxEvent.findFirst({
          where: { aggregateId: privateReply.id, eventType: 'message.created' },
        })
      ).status === 'published',
    'reassignment notification processed',
  );
  assert.ok(!agentEvents.some((e) => e.data.id === privateReply.id));
  await request(adminA, 'PATCH', `/memberships/${agentMember}`, {
    expectedVersion: accepted.membership.version,
    status: 'disabled',
  });
  await until(() => !agentSocket.connected, 'disabled member disconnect');
  await assert.rejects(connect(agent));
  // The same account remains valid in its other organization.
  const stillAuthorized = await connect(adminB);
  assert.equal(stillAuthorized.connected, true);
  await db.query(
    "UPDATE conversations SET status='closed',closed_at=now(),resolution='agent_resolved',version=version+1 WHERE id=$1",
    [cid],
  );
  const closedSocket = await connect(va);
  assert.equal(
    (
      await ack(
        closedSocket,
        'message.send',
        {
          conversationId: cid,
          clientMessageId: randomUUID(),
          content: 'closed cannot send',
        },
        false,
      )
    ).error.code,
    'CONVERSATION_CLOSED',
  );
  pass(
    'assignment changes block old subscriptions and sends; disabled member disconnects without affecting other organization; closed conversation rejects new messages',
  );
  if (process.env.REALTIME_API_VERIFICATION) {
    const archive = spawnSync(
      process.execPath,
      [process.env.REALTIME_API_VERIFICATION],
      {
        cwd: root,
        env: {
          ...process.env,
          PROJECT_ROOT: root,
          API_BASE_URL: api,
          VISITOR_TOKEN: va.token,
          WIDGET_ORIGIN: origin,
        },
        encoding: 'utf8',
        windowsHide: true,
        timeout: 20000,
      },
    );
    await writeFile(
      resolve(evidence, 'archive.log'),
      archive.stdout + archive.stderr,
    );
    assert.equal(archive.status, 0, archive.stdout + archive.stderr);
    pass(
      'archived Socket and HTTP recovery contract executed against existing isolated API',
    );
  }
  const configBeforeDisable = (await request(adminA, 'GET', '/widget-config'))
    .data;
  await request(adminA, 'PATCH', '/widget-config', {
    expectedVersion: configBeforeDisable.version,
    enabled: false,
  });
  await until(() => !closedSocket.connected, 'disabled site disconnect');
  await assert.rejects(connect(va));
  await request(adminA, 'PATCH', '/widget-config', {
    expectedVersion: configBeforeDisable.version + 1,
    enabled: true,
  });
  const beforeRevocation = await connect(va);
  pass(
    'disabled site invalidates existing visitor connections and new handshakes',
  );
  const logged = await connect(adminA);
  await ack(logged, 'conversation.subscribe', { conversationId: cid });
  await request(adminA, 'POST', '/auth/logout', {}, 204);
  await until(() => !logged.connected, 'logout disconnect');
  await db.query(
    'UPDATE visitor_sessions SET revoked_at=now() WHERE customer_id=$1',
    [va.customer.id],
  );
  await until(() => !beforeRevocation.connected, 'visitor revocation');
  await assert.rejects(connect(va));
  pass(
    'live session logout and visitor revocation disconnect old connections; reconnect denied',
  );
} finally {
  for (const s of sockets) s.disconnect();
  await browser?.close();
  await worker?.close();
  await publisher?.close();
  await queue?.close();
  for (const item of children.reverse()) {
    if (!item.exit) item.child.kill();
    await item.done;
    await writeFile(resolve(evidence, `api-${item.pid}.log`), item.output);
  }
  if (fixture) await new Promise((r) => fixture.close(r));
  await prisma?.$disconnect();
  if (connected) await db.end();
  if (redisStarted) docker('rm', '-f', container);
  if (created) await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
  if (initial) {
    const after = await snapshot();
    await writeFile(
      resolve(evidence, 'main-after.json'),
      JSON.stringify(after),
    );
    assert.deepEqual(after, initial);
  }
  await main.end();
  await admin.end();
  for (const item of children)
    await assert.rejects(fetch(`http://127.0.0.1:${item.port}/health/live`));
  await writeFile(
    resolve(evidence, 'result.json'),
    JSON.stringify(
      {
        scenarios: results,
        database: name,
        redisContainer: container,
        children: children.map(
          ({ pid, port, command, cwd, enabled, exit }) => ({
            pid,
            port,
            command,
            cwd,
            enabled,
            exit,
          }),
        ),
        cleanup: 'PASS',
      },
      null,
      2,
    ),
  );
  console.info('CLEANUP PASS; scenarios=' + results.length);
}
