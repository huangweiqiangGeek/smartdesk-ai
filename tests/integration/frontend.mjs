import assert from 'node:assert/strict';
import console from 'node:console';
import process from 'node:process';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createServer as portServer } from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from '@playwright/test';
import ts from 'typescript';

const root = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(
  new URL('../../apps/server/package.json', import.meta.url),
);
require('dotenv').config({ path: resolve(root, '.env'), quiet: true });
const { Client } = require('pg');
const base = new URL(process.env.DATABASE_URL);
assert.ok(['localhost', '127.0.0.1'].includes(base.hostname));
const name = `smartdesk_t07_${process.pid}_${Date.now()}`;
assert.match(name, /^smartdesk_t07_\d+_\d+$/);
const adminUrl = new URL(base),
  testUrl = new URL(base);
adminUrl.pathname = '/postgres';
testUrl.pathname = '/' + name;
assert.notEqual(base.pathname, testUrl.pathname);
const main = new Client({ connectionString: base.href });
const admin = new Client({ connectionString: adminUrl.href });
const db = new Client({ connectionString: testUrl.href });
const evidence = resolve(root, 'test-results/frontend');
const results = [],
  processes = [],
  requests = [];
let browser,
  fixture,
  before,
  created = false,
  connected = false,
  api,
  origin;
function pass(label) {
  results.push(label);
  console.info('PASS ' + label);
}
async function snapshot() {
  const tables = (
    await main.query(
      "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename",
    )
  ).rows;
  const value = {};
  for (const { tablename } of tables) {
    assert.match(tablename, /^[a-z_]+$/);
    value[tablename] = (
      await main.query(
        `SELECT count(*)::int AS count, md5(coalesce(string_agg(to_jsonb(t)::text, '' ORDER BY to_jsonb(t)::text),'')) AS digest FROM "${tablename}" t`,
      )
    ).rows[0];
  }
  return value;
}
async function freePort() {
  const s = portServer();
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const port = s.address().port;
  await new Promise((r) => s.close(r));
  return port;
}
async function request(actor, method, path, body, status = 200) {
  const response = await fetch(api + '/api/v1' + path, {
    method,
    signal: AbortSignal.timeout(15000),
    headers: {
      Origin: origin,
      'Content-Type': 'application/json',
      'X-Requested-With': 'SmartDesk',
      'Idempotency-Key': randomUUID(),
      ...(actor?.cookie ? { Cookie: actor.cookie } : {}),
      ...(actor?.org ? { 'X-Organization-Id': actor.org } : {}),
      ...(actor?.token ? { Authorization: `Bearer ${actor.token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const value = response.status === 204 ? {} : await response.json();
  assert.equal(response.status, status, JSON.stringify(value));
  return {
    ...value,
    cookie: response.headers.get('set-cookie')?.split(';')[0],
  };
}
async function setupOwner(label) {
  const registered = await request(
    null,
    'POST',
    '/auth/register',
    {
      email: `${label}@t07.invalid`,
      password: 'T07-password-long-123!',
      displayName: label,
    },
    201,
  );
  const actor = { cookie: registered.cookie };
  const org = (
    await request(actor, 'POST', '/organizations', { name: label }, 201)
  ).data;
  actor.org = org.id;
  actor.membershipId = org.membership.id;
  actor.userId = org.membership.userId;
  const config = (await request(actor, 'GET', '/widget-config')).data;
  await request(actor, 'PATCH', '/widget-config', {
    expectedVersion: config.version,
    enabled: true,
    allowedOrigins: [origin],
  });
  actor.key = config.publicKey;
  return actor;
}
const moduleNames = new Set([
  'api',
  'message-state',
  'socket',
  'support-client',
]);
const html =
  () => `<!doctype html><html lang="zh-CN"><title>T07 隔离客户端验收</title><textarea aria-label="草稿"></textarea><pre id="state"></pre>
<script type="importmap">{"imports":{"socket.io-client":"/vendor.js"}}</script><script type="module">
import { SupportClient } from '/modules/support-client';
import { createSocket } from '/modules/socket';
window.fault = { hold: false, dropAck: false }; window.buffered = []; window.callbacks = [];
window.client = new SupportClient(${JSON.stringify(api)}, { socketFactory(identity) {
 const transport = createSocket(${JSON.stringify(api)}, identity);
 return { get connected() { return transport.connected; }, connect:()=>transport.connect(), disconnect:()=>transport.disconnect(), off:()=>transport.off(),
 on(event, listener) { if (event==='message.created') { window.callbacks.push(listener); transport.on(event, value=> { if(window.fault.hold) window.buffered.push(value); else listener(value); }); } else transport.on(event,listener); },
 async request(event, body) { const ack=await transport.request(event, body); if(event==='message.send' && window.fault.dropAck) throw new Error('test lost ACK after actual server commit'); return ack; } };
} });
window.client.listen(state=>{window.state=state; document.querySelector('#state').textContent=JSON.stringify(state);});
document.querySelector('textarea').addEventListener('input', event=>window.client.setDraft(event.target.value));
window.ready=true;
</script></html>`;
try {
  await mkdir(evidence, { recursive: true });
  await main.connect();
  await admin.connect();
  before = await snapshot();
  await writeFile(
    resolve(evidence, 'main-before.json'),
    JSON.stringify(before),
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
  api = `http://127.0.0.1:${await freePort()}`;
  fixture = createServer((req, res) => {
    void (async () => {
      const path = new URL(req.url, 'http://fixture').pathname;
      if (path.startsWith('/api/v1/')) {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const body = Buffer.concat(chunks);
        requests.push({
          method: req.method,
          path: req.url,
          bearer: Boolean(req.headers.authorization),
          cookie: Boolean(req.headers.cookie),
        });
        const headers = { ...req.headers, origin };
        delete headers.host;
        delete headers['content-length'];
        const result = await fetch(api + req.url, {
          method: req.method,
          headers,
          body: body.length ? body : undefined,
        });
        res.statusCode = result.status;
        res.setHeader('Content-Type', 'application/json');
        if (result.headers.getSetCookie().length)
          res.setHeader('Set-Cookie', result.headers.getSetCookie());
        res.end(Buffer.from(await result.arrayBuffer()));
      } else if (path.startsWith('/modules/')) {
        const name = path.slice('/modules/'.length).replace(/\.ts$/, '');
        assert.ok(moduleNames.has(name));
        const source = await readFile(
          resolve(root, `apps/web/app/services/${name}.ts`),
          'utf8',
        );
        const output = ts.transpileModule(source, {
          compilerOptions: {
            target: ts.ScriptTarget.ES2022,
            module: ts.ModuleKind.ESNext,
          },
        }).outputText;
        res.setHeader('Content-Type', 'text/javascript');
        res.end(output);
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
        res.end(html());
      }
    })().catch((error) => {
      res.statusCode = 500;
      res.end(error.message);
    });
  });
  await new Promise((r) => fixture.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${fixture.address().port}`;
  const script = resolve(root, 'apps/server/dist/main.js');
  const child = spawn(process.execPath, [script], {
    cwd: root,
    windowsHide: true,
    env: {
      ...process.env,
      DATABASE_URL: testUrl.href,
      API_HOST: '127.0.0.1',
      API_PORT: new URL(api).port,
      APP_ORIGIN: origin,
      WIDGET_ORIGIN: origin,
      OUTBOX_ENABLED: 'true',
      AI_MODE: 'disabled',
      REDIS_URL: 'redis://127.0.0.1:1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const item = {
    child,
    pid: child.pid,
    command: `node ${script}`,
    cwd: root,
    port: Number(new URL(api).port),
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
  processes.push(item);
  console.info(
    JSON.stringify({
      command: item.command,
      pid: item.pid,
      port: item.port,
      cwd: root,
    }),
  );
  for (let i = 0; ; i++) {
    if (item.exit || i > 600)
      throw new Error('API startup failed: ' + item.output);
    try {
      if (
        (
          await fetch(api + '/health/live', {
            signal: AbortSignal.timeout(1000),
          })
        ).ok
      )
        break;
    } catch {
      /* bounded startup */
    }
    await delay(100);
  }
  const owner = await setupOwner('owner'),
    other = await setupOwner('other');
  const bootstrap = (
    await request(
      null,
      'POST',
      `/public/widgets/${owner.key}/bootstrap`,
      {},
      201,
    )
  ).data;
  const visitor = { token: bootstrap.visitorToken };
  const first = (
    await request(
      visitor,
      'POST',
      '/conversations',
      {
        clientConversationId: randomUUID(),
        firstMessage: { clientMessageId: randomUUID(), content: '消息1' },
      },
      201,
    )
  ).data;
  const cid = first.conversation.id;
  await db.query(
    "UPDATE conversations SET status='human_active', assigned_membership_id=$1 WHERE id=$2",
    [owner.membershipId, cid],
  );
  for (let i = 2; i <= 70; i++)
    await request(
      visitor,
      'POST',
      `/conversations/${cid}/messages`,
      { clientMessageId: randomUUID(), content: `消息${i}` },
      201,
    );
  const identity = {
    kind: 'visitor',
    customerId: bootstrap.customer.id,
    publicKey: owner.key,
    token: visitor.token,
  };
  const memberIdentity = {
    kind: 'member',
    userId: owner.userId,
    organizationId: owner.org,
    membershipId: owner.membershipId,
  };
  browser = await chromium.launch({ headless: true });
  const visitorContext = await browser.newContext(),
    memberContext = await browser.newContext();
  await memberContext.addCookies([
    {
      name: 'smartdesk_session',
      value: owner.cookie.split('=')[1],
      url: origin,
    },
  ]);
  const page = await visitorContext.newPage(),
    staff = await memberContext.newPage();
  const browserErrors = [];
  for (const p of [page, staff])
    p.on('pageerror', (e) => browserErrors.push(e.message));
  await page.goto(origin);
  await staff.goto(origin);
  await page.waitForFunction(() => window.ready);
  await staff.waitForFunction(() => window.ready);
  for (const [p, value] of [
    [page, identity],
    [staff, memberIdentity],
  ]) {
    await p.evaluate((value) => window.client.setIdentity(value), value);
    await p.waitForFunction(() => window.state.connection === 'socket');
    await p.evaluate((id) => {
      window.release = window.client.openConversation(id);
    }, cid);
    await p.waitForFunction(
      () => !window.state.loading && window.state.lastContiguousSeq === 70,
    );
    assert.equal(await p.evaluate(() => window.state.messages.length), 50);
  }
  pass('真实两浏览器双身份订阅，固定水位最新50条');
  await page.evaluate(() => window.client.loadOlder());
  assert.equal(await page.evaluate(() => window.state.messages.length), 70);
  assert.equal(await page.evaluate(() => window.state.lastContiguousSeq), 70);
  pass('真实beforeSeq上翻不倒退实时连续游标');
  const idA = randomUUID(),
    idB = randomUUID();
  await page.evaluate(
    ([a, b]) => {
      window.client.send('相同文字', a);
      window.client.send('相同文字', b);
    },
    [idA, idB],
  );
  await page.waitForFunction(
    () =>
      window.state.lastContiguousSeq === 72 &&
      window.state.messages.every((m) => m.status === 'sent'),
  );
  await staff.waitForFunction(() => window.state.lastContiguousSeq === 72);
  assert.equal(
    await page.evaluate(
      () =>
        window.state.messages.filter((m) => m.content === '相同文字').length,
    ),
    2,
  );
  pass('真实Socket发送/广播/ACK归并，同文不同ID保留');
  await page.evaluate(() => {
    window.fault.hold = true;
    window.fault.dropAck = true;
  });
  const lostId = randomUUID();
  await page.evaluate((id) => window.client.send('ACK丢失', id), lostId);
  await page.waitForFunction(
    (id) =>
      window.state.messages.some(
        (m) => m.clientMessageId === id && m.status === 'sent',
      ),
    lostId,
  );
  assert.equal(
    (
      await db.query(
        'SELECT count(*)::int n FROM messages WHERE conversation_id=$1 AND client_message_id=$2',
        [cid, lostId],
      )
    ).rows[0].n,
    1,
  );
  pass('实际提交后丢ACK且暂扣广播，A040确认原消息且不重复发送');
  await page.evaluate(() => {
    window.buffered = [];
    window.fault.dropAck = false;
  });
  const m74 = (
    await request(
      visitor,
      'POST',
      `/conversations/${cid}/messages`,
      { clientMessageId: randomUUID(), content: '乱序74' },
      201,
    )
  ).data;
  const m75 = (
    await request(
      visitor,
      'POST',
      `/conversations/${cid}/messages`,
      { clientMessageId: randomUUID(), content: '乱序75' },
      201,
    )
  ).data;
  await page.waitForFunction(() =>
    window.buffered.some((e) => e.data.seq === 75),
  );
  await page.evaluate(() => {
    const listener = window.callbacks.at(-1),
      high = window.buffered.find((e) => e.data.seq === 75);
    listener(high);
    listener(high);
  });
  await page.waitForFunction(() => window.state.lastContiguousSeq === 75);
  assert.equal(
    await page.evaluate(
      (id) => window.state.messages.filter((m) => m.id === id).length,
      m74.id,
    ),
    1,
  );
  assert.equal(
    await page.evaluate(
      (id) => window.state.messages.filter((m) => m.id === id).length,
      m75.id,
    ),
    1,
  );
  await page.evaluate(() => {
    window.fault.hold = false;
    window.buffered = [];
  });
  pass('真实消息事件75先到/重复，afterSeq补齐74且没有跳缺口');
  await page.getByRole('textbox', { name: '草稿' }).fill('人工输入不可覆盖');
  await visitorContext.setOffline(true);
  await page.waitForFunction(() => window.state.connection === 'http');
  const missed = (
    await request(
      visitor,
      'POST',
      `/conversations/${cid}/messages`,
      { clientMessageId: randomUUID(), content: '离线期间' },
      201,
    )
  ).data;
  const offlineId = randomUUID();
  await page.evaluate((id) => window.client.send('离线待确认', id), offlineId);
  await page.waitForFunction(
    (id) =>
      window.state.messages.some(
        (m) => m.clientMessageId === id && m.status === 'pending',
      ),
    offlineId,
  );
  await visitorContext.setOffline(false);
  await page.waitForFunction(() => window.state.connection === 'socket');
  await page.waitForFunction(
    (seq) => window.state.lastContiguousSeq >= seq,
    missed.seq,
  );
  await page.evaluate((id) => window.client.retry(id), offlineId);
  await page.waitForFunction(
    (id) =>
      window.state.messages.some(
        (m) => m.clientMessageId === id && m.status === 'sent',
      ),
    offlineId,
  );
  assert.equal(
    await page.evaluate(() => window.state.draft.text),
    '人工输入不可覆盖',
  );
  pass('真实断网/重连补拉、稳定ID重试与人工草稿保留');
  // A fresh context with Socket transports blocked exercises HTTP recovery independently of a prior successful handshake.
  const fallbackContext = await browser.newContext();
  await fallbackContext.route('**/socket.io/**', (route) => route.abort());
  const fallback = await fallbackContext.newPage();
  await fallback.goto(origin);
  await fallback.waitForFunction(() => window.ready);
  await fallback.evaluate(
    ({ identity, cid }) => {
      window.client.setIdentity(identity);
      window.client.openConversation(cid);
    },
    { identity, cid },
  );
  await fallback.waitForFunction(
    () => !window.state.loading && window.state.connection === 'http',
  );
  const fallbackId = randomUUID();
  await fallback.evaluate(
    (id) => window.client.send('HTTP备用发送', id),
    fallbackId,
  );
  await fallback.waitForFunction(
    (id) =>
      window.state.messages.some(
        (m) => m.clientMessageId === id && m.status === 'sent',
      ),
    fallbackId,
  );
  const pollMessage = (
    await request(
      visitor,
      'POST',
      `/conversations/${cid}/messages`,
      { clientMessageId: randomUUID(), content: 'HTTP补拉' },
      201,
    )
  ).data;
  await fallback.waitForFunction(
    (seq) => window.state.lastContiguousSeq >= seq,
    pollMessage.seq,
  );
  await fallback.screenshot({ path: resolve(evidence, 'http-fallback.png') });
  await fallbackContext.close();
  pass('无成功Socket前置的HTTP发送与3秒补拉');
  const oldEvent = { type: 'message.created', data: m75 };
  await staff.getByRole('textbox', { name: '草稿' }).fill('企业A草稿');
  const beforeGeneration = await staff.evaluate(
    () => window.state.contextGeneration,
  );
  await staff.evaluate(
    ({ other, oldEvent }) => {
      const late = window.callbacks[0];
      window.client.setIdentity({
        kind: 'member',
        userId: other.userId,
        organizationId: other.org,
        membershipId: other.membershipId,
      });
      late(oldEvent);
    },
    { other, oldEvent },
  );
  assert.ok(
    await staff.evaluate(
      (n) =>
        window.state.contextGeneration > n &&
        window.state.messages.length === 0 &&
        window.state.draft.text === '',
      beforeGeneration,
    ),
  );
  await staff.evaluate(() => window.client.setIdentity(null));
  assert.equal(await staff.evaluate(() => window.state.connection), 'idle');
  pass('切企业/退出清空缓存草稿，旧连接迟到事件被丢弃');
  await db.query(
    'UPDATE visitor_sessions SET revoked_at=now() WHERE customer_id=$1',
    [bootstrap.customer.id],
  );
  await page.waitForFunction(() => window.state.connection === 'expired');
  assert.equal(await page.evaluate(() => window.state.messages.length), 0);
  pass('服务端撤销访客凭据后客户端断开并清私密状态');
  assert.deepEqual(browserErrors, []);
  assert.ok(requests.filter((r) => r.bearer).every((r) => !r.cookie));
  pass('浏览器无运行时异常，访客HTTP未附带成员Cookie');
} finally {
  await browser?.close();
  for (const item of processes.reverse()) {
    if (!item.exit) item.child.kill();
    await item.done;
    await writeFile(resolve(evidence, `api-${item.pid}.log`), item.output);
  }
  if (fixture) {
    fixture.closeAllConnections();
    await new Promise((r) => fixture.close(r));
  }
  if (connected) await db.end();
  if (created) await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
  if (before) {
    const after = await snapshot();
    await writeFile(
      resolve(evidence, 'main-after.json'),
      JSON.stringify(after),
    );
    assert.deepEqual(after, before);
  }
  await main.end();
  await admin.end();
  for (const item of processes)
    await assert.rejects(fetch(`http://127.0.0.1:${item.port}/health/live`));
  await writeFile(
    resolve(evidence, 'result.json'),
    JSON.stringify(
      {
        scenarios: results,
        database: name,
        mainTables: Object.keys(before ?? {}).length,
        processes: processes.map(({ pid, port, command, cwd, exit }) => ({
          pid,
          port,
          command,
          cwd,
          exit,
        })),
        cleanup: 'PASS',
        modelCalls: 0,
      },
      null,
      2,
    ),
  );
  console.info('CLEANUP PASS; scenarios=' + results.length);
}
