import assert from 'node:assert/strict';
import console from 'node:console';
import process from 'node:process';
import { randomUUID } from 'node:crypto';
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
require('dotenv').config({ path: resolve(root, '.env'), quiet: true });
const { Client } = require('pg');
const base = new URL(process.env.DATABASE_URL);
assert.ok(['localhost', '127.0.0.1'].includes(base.hostname));
const name = `smartdesk_t09_${process.pid}_${Date.now()}`;
assert.match(name, /^smartdesk_t09_\d+_\d+$/);
const adminUrl = new URL(base),
  testUrl = new URL(base);
adminUrl.pathname = '/postgres';
testUrl.pathname = '/' + name;
assert.notEqual(testUrl.pathname, base.pathname);
const admin = new Client({ connectionString: adminUrl.href }),
  db = new Client({ connectionString: testUrl.href }),
  main = new Client({ connectionString: base.href });
const evidence = resolve(root, 'test-results/inbox');
const children = [],
  results = [],
  contexts = [],
  errors = [];
let browser,
  created = false,
  connected = false,
  before;
const parent = 'https://t09.customer.test';
async function port() {
  const server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const value = server.address().port;
  await new Promise((r) => server.close(r));
  return value;
}
const webPort = await port(),
  apiPort = await port();
const web = `http://127.0.0.1:${webPort}`,
  api = `http://127.0.0.1:${apiPort}`;
const pass = (label) => {
  results.push(label);
  console.info('PASS ' + label);
};
async function snapshot() {
  const value = {};
  // Active experience sessions may heartbeat and the existing outbox worker may lease rows.
  // Those runtime tables are not business data; all other public tables are compared byte-for-byte.
  for (const { tablename } of (
    await main.query(
      "SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename NOT IN ('presence_connections','outbox_events') ORDER BY tablename",
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
async function start(label, script, env, health) {
  const child = spawn(process.execPath, [resolve(root, script)], {
    cwd: root,
    windowsHide: true,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const item = {
    label,
    child,
    pid: child.pid,
    script,
    cwd: root,
    health,
    output: '',
    exit: null,
  };
  item.done = new Promise((r) =>
    child.once('exit', (code, signal) => {
      item.exit = { code, signal };
      r();
    }),
  );
  child.stdout.on('data', (b) => (item.output += b));
  child.stderr.on('data', (b) => (item.output += b));
  children.push(item);
  for (let i = 0; i < 150; i++) {
    if (item.exit) throw new Error(item.output);
    try {
      if ((await fetch(health, { signal: AbortSignal.timeout(1000) })).ok)
        return;
    } catch {
      /* starting */
    }
    await delay(200);
  }
  throw new Error('Startup timed out: ' + item.output);
}
async function request(actor, method, path, body, status = 200, extra = {}) {
  const r = await fetch(api + '/api/v1' + path, {
    method,
    signal: AbortSignal.timeout(15000),
    headers: {
      Origin: web,
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
      ...extra,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const value = r.status === 204 ? {} : await r.json();
  assert.ok(
    (Array.isArray(status) ? status : [status]).includes(r.status),
    `${method} ${path}: ${r.status} ${JSON.stringify(value)}`,
  );
  return {
    ...value,
    status: r.status,
    cookie: r.headers.get('set-cookie')?.split(';')[0],
  };
}
async function register(label) {
  const r = await request(
    null,
    'POST',
    '/auth/register',
    {
      email: `${label}@t09.invalid`,
      password: 'T09-password-long-123!',
      displayName: label,
    },
    201,
  );
  return { cookie: r.cookie, userId: r.data.id, label };
}
async function join(owner, label) {
  const actor = await register(label);
  const invite = (
    await request(owner, 'POST', '/invitations', { role: 'agent' }, 201)
  ).data;
  const result = (
    await request(actor, 'POST', '/invitations/accept', {
      token: new URL(invite.inviteLink).hash.slice(1),
    })
  ).data;
  return { ...actor, org: owner.org, membershipId: result.membership.id };
}
async function available(actor) {
  await request(actor, 'PATCH', '/memberships/me/availability', {
    availability: 'available',
  });
  await request(actor, 'POST', '/presence/heartbeat', {
    connectionId: randomUUID(),
  });
}
async function context(actor) {
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  contexts.push(ctx);
  await ctx.tracing.start({
    screenshots: true,
    snapshots: true,
    sources: true,
  });
  if (actor?.cookie) {
    const i = actor.cookie.indexOf('=');
    await ctx.addCookies([
      {
        name: actor.cookie.slice(0, i),
        value: actor.cookie.slice(i + 1),
        url: web,
      },
    ]);
  }
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  return page;
}
const detail = async (a, id) =>
  (await request(a, 'GET', `/conversations/${id}`)).data;
const send = (a, id, content, status = 201) =>
  request(
    a,
    'POST',
    `/conversations/${id}/messages`,
    { clientMessageId: randomUUID(), content },
    status,
  );
try {
  await mkdir(evidence, { recursive: true });
  await admin.connect();
  await main.connect();
  before = await snapshot();
  await admin.query(`CREATE DATABASE "${name}"`);
  created = true;
  const migration = spawnSync(
    process.execPath,
    [resolve(root, 'node_modules/prisma/build/index.js'), 'migrate', 'deploy'],
    {
      cwd: root,
      windowsHide: true,
      encoding: 'utf8',
      env: { ...process.env, DATABASE_URL: testUrl.href },
    },
  );
  await writeFile(
    resolve(evidence, 'migration.log'),
    migration.stdout + migration.stderr,
  );
  assert.equal(migration.status, 0);
  await db.connect();
  connected = true;
  await start(
    'api',
    'apps/server/dist/main.js',
    {
      DATABASE_URL: testUrl.href,
      API_HOST: '127.0.0.1',
      API_PORT: String(apiPort),
      APP_ORIGIN: web,
      WIDGET_ORIGIN: web,
      AI_MODE: 'disabled',
      OUTBOX_ENABLED: 'true',
      REDIS_URL: 'redis://127.0.0.1:1',
    },
    api + '/health/live',
  );
  await start(
    'web',
    'apps/web/.output/server/index.mjs',
    {
      PORT: String(webPort),
      NITRO_PORT: String(webPort),
      HOST: '127.0.0.1',
      NITRO_HOST: '127.0.0.1',
      NUXT_API_BASE: api,
      NUXT_PUBLIC_SOCKET_BASE: api,
    },
    web + '/login',
  );
  const boss = await register('管理员'),
    org = (
      await request(
        boss,
        'POST',
        '/organizations',
        { name: 'T09 验收团队' },
        201,
      )
    ).data;
  Object.assign(boss, { org: org.id, membershipId: org.membership.id });
  const alice = await join(boss, '客服甲'),
    bob = await join(boss, '客服乙');
  for (const a of [boss, alice, bob]) await available(a);
  const config = (await request(boss, 'GET', '/widget-config')).data;
  await request(boss, 'PATCH', '/widget-config', {
    expectedVersion: config.version,
    enabled: true,
    allowedOrigins: [parent],
  });
  const bootstrap = (
    await request(
      null,
      'POST',
      `/public/widgets/${config.publicKey}/bootstrap`,
      {},
      201,
      { Origin: parent },
    )
  ).data;
  const visitor = { token: bootstrap.visitorToken };
  browser = await chromium.launch({
    headless: process.env.INBOX_HEADED !== 'true',
    ...(process.env.INBOX_HEADED === 'true' ? { channel: 'chrome' } : {}),
  });
  const customer = await context();
  // Test-only visitor window. It uses real Bearer HTTP requests, never synthetic messages or T10 product claims.
  await customer.route(web + '/t09-visitor', (route) =>
    route.fulfill({
      contentType: 'text/html; charset=utf-8',
      body: `<!doctype html><html lang="zh"><meta charset="utf-8"><title>T09 访客验收窗口</title><h1>访客验收窗口（测试夹具）</h1><label>访客消息<textarea id="input"></textarea></label><button id="send">发送咨询</button><p role="status" id="status"></p><section aria-label="访客消息记录" id="messages"></section><script>
const token=${JSON.stringify(visitor.token)}; let conversationId=null;
async function api(path,method='GET',body){const r=await fetch('/api/v1'+path,{method,credentials:'omit',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json','Idempotency-Key':crypto.randomUUID()},body:body?JSON.stringify(body):undefined});const v=await r.json();if(!r.ok)throw Error(v.error.message);return v.data;}
window.readHistory=()=>api('/conversations/'+conversationId+'/messages');
window.conversation=()=>conversationId;
document.querySelector('#send').onclick=async()=>{try{const content=document.querySelector('#input').value; if(!conversationId){const result=await api('/conversations','POST',{clientConversationId:crypto.randomUUID(),firstMessage:{clientMessageId:crypto.randomUUID(),content}});conversationId=result.conversation.id;}else await api('/conversations/'+conversationId+'/messages','POST',{clientMessageId:crypto.randomUUID(),content});document.querySelector('#input').value='';document.querySelector('#status').textContent='发送已保存';await refresh();}catch(e){document.querySelector('#status').textContent=e.message;}};
async function refresh(){if(conversationId){try{const data=await window.readHistory();document.querySelector('#messages').replaceChildren(...data.items.map(m=>{const p=document.createElement('p');p.textContent=m.content;return p;}));}catch(e){document.querySelector('#status').textContent=e.message;}}}setInterval(refresh,700);
</script></html>`,
    }),
  );
  await customer.goto(web + '/t09-visitor');
  await customer
    .getByLabel('访客消息', { exact: true })
    .fill('我需要修改订单，麻烦协助。');
  await customer.getByRole('button', { name: '发送咨询' }).click();
  await expect(customer.getByRole('status')).toHaveText('发送已保存');
  const id = await customer.evaluate(() => window.conversation());
  const a = await context(alice),
    b = await context(bob),
    adminPage = await context(boss);
  const url = `${web}/app/o/${boss.org}/inbox`;
  await Promise.all([a.goto(url), b.goto(url), adminPage.goto(`${url}/${id}`)]);
  for (const page of [a, b])
    await expect(page.locator(`[data-conversation="${id}"]`)).toContainText(
      '我需要修改订单',
    );
  await expect(
    adminPage.getByRole('button', { name: '发送回复', exact: true }),
  ).toBeDisabled();
  await send(boss, id, '管理员未接管不可发送', 403);
  await expect(
    adminPage.getByText('尚未接入，当前不可用。', { exact: true }),
  ).toBeVisible();
  pass(
    '真实访客发起咨询；两名客服授权列表自动刷新，管理员未接管禁发，AI 明确不可用',
  );

  for (const page of [a, b]) {
    await page.locator(`[data-conversation="${id}"]`).click();
    await expect(
      page.getByRole('button', { name: '认领会话', exact: true }),
    ).toBeVisible();
    await page.getByLabel('公开回复', { exact: true }).fill('认领前保留的草稿');
  }
  const held = [];
  for (const page of [a, b])
    await page.route(`**/conversations/${id}/claim`, async (route) => {
      held.push(route);
      if (held.length === 2) await Promise.all(held.map((r) => r.continue()));
    });
  await Promise.all([
    a.getByRole('button', { name: '认领会话', exact: true }).click(),
    b.getByRole('button', { name: '认领会话', exact: true }).click(),
  ]);
  await expect
    .poll(async () => (await detail(boss, id)).status)
    .toBe('human_active');
  const owned = await detail(boss, id),
    winner = owned.assignedMembershipId === alice.membershipId ? alice : bob;
  const winnerPage = winner === alice ? a : b,
    loserPage = winner === alice ? b : a,
    loser = winner === alice ? bob : alice;
  await expect(
    winnerPage.getByRole('button', { name: '发送回复', exact: true }),
  ).toBeEnabled();
  await expect(
    loserPage.getByRole('alert').filter({ hasText: '409' }),
  ).toBeVisible();
  await expect(
    loserPage.getByRole('button', { name: '发送回复', exact: true }),
  ).toBeDisabled();
  await expect(loserPage.getByLabel('公开回复', { exact: true })).toHaveValue(
    '认领前保留的草稿',
  );
  await expect(loserPage.locator(`[data-conversation="${id}"]`)).toHaveCount(0);
  pass(
    '两个真实客服窗口同时认领：仅一人成功，竞争者 409、列表撤出、草稿保留并禁发',
  );

  await winnerPage
    .getByLabel('公开回复', { exact: true })
    .fill('您好，我来协助处理。');
  await winnerPage.getByLabel('公开回复', { exact: true }).press('Shift+Enter');
  await expect(winnerPage.getByLabel('公开回复', { exact: true })).toHaveValue(
    '您好，我来协助处理。\n',
  );
  await winnerPage.getByLabel('公开回复', { exact: true }).press('Enter');
  await expect(
    customer.getByRole('region', { name: '访客消息记录' }),
  ).toContainText('您好，我来协助处理。');
  await expect(
    winnerPage.locator('.inbox-message[data-status="sent"]', {
      hasText: '您好，我来协助处理。',
    }),
  ).toHaveCount(1);
  await expect(
    winnerPage.getByText('实时连接已建立', { exact: true }),
  ).toBeVisible();
  await winnerPage
    .getByLabel('公开回复', { exact: true })
    .fill('公开草稿不可覆盖');
  await winnerPage
    .getByRole('button', { name: '内部备注 · 仅团队可见' })
    .click();
  await winnerPage
    .getByLabel('内部备注（仅团队可见）')
    .fill('仅团队：待核对订单编号。');
  await winnerPage.getByRole('button', { name: '保存内部备注' }).click();
  await expect(winnerPage.locator('.inbox-note')).toContainText(
    '仅团队：待核对订单编号。',
  );
  await winnerPage
    .getByRole('button', { name: '公开消息', exact: true })
    .click();
  await expect(winnerPage.getByLabel('公开回复', { exact: true })).toHaveValue(
    '公开草稿不可覆盖',
  );
  await customer
    .getByLabel('访客消息', { exact: true })
    .fill('谢谢，请保留原配送地址。');
  await customer.getByRole('button', { name: '发送咨询' }).click();
  await expect(
    winnerPage
      .locator('.inbox-message')
      .filter({ hasText: '谢谢，请保留原配送地址。' }),
  ).toHaveCount(1);
  await expect(winnerPage.getByLabel('公开回复', { exact: true })).toHaveValue(
    '公开草稿不可覆盖',
  );
  assert.doesNotMatch(
    JSON.stringify(await customer.evaluate(() => window.readHistory())),
    /仅团队/,
  );
  await request(visitor, 'GET', `/conversations/${id}/notes`, undefined, 403);
  await request(
    visitor,
    'POST',
    `/conversations/${id}/notes`,
    { clientNoteId: randomUUID(), content: '冒充备注' },
    403,
  );
  await request(loser, 'GET', `/conversations/${id}/notes`, undefined, 404);
  pass(
    '真实公开消息双向可见、Socket 单次归并、Enter/Shift+Enter；新消息不覆盖草稿，备注与访客历史隔离',
  );

  const noteId = randomUUID(),
    noteBody = { clientNoteId: noteId, content: '幂等备注' };
  const concurrentNotes = await Promise.all([
    request(winner, 'POST', `/conversations/${id}/notes`, noteBody, [200, 201]),
    request(winner, 'POST', `/conversations/${id}/notes`, noteBody, [200, 201]),
  ]);
  assert.equal(concurrentNotes[0].data.id, concurrentNotes[1].data.id);
  await request(
    winner,
    'POST',
    `/conversations/${id}/notes`,
    { ...noteBody, content: '不同正文' },
    409,
  );
  const firstNotes = (
    await request(winner, 'GET', `/conversations/${id}/notes?limit=1`)
  ).data;
  assert.ok(firstNotes.nextCursor);
  await request(
    boss,
    'GET',
    `/conversations/${id}/notes?cursor=${firstNotes.nextCursor}`,
    undefined,
    422,
  );
  await request(
    winner,
    'POST',
    `/conversations/${id}/notes`,
    { clientNoteId: randomUUID(), content: '  ' },
    422,
  );
  const secondNotes = (
    await request(
      winner,
      'GET',
      `/conversations/${id}/notes?limit=1&cursor=${firstNotes.nextCursor}`,
    )
  ).data;
  assert.notEqual(firstNotes.items[0].id, secondNotes.items[0].id);
  assert.equal(
    (await db.query('SELECT count(*)::int n FROM ai_tasks')).rows[0].n,
    0,
  );
  assert.equal(
    (await detail(boss, id)).unreadCount,
    2,
    'agent messages must not increment unread',
  );
  await winnerPage
    .getByRole('button', { name: '标记已读', exact: true })
    .click();
  await expect.poll(async () => (await detail(winner, id)).unreadCount).toBe(0);
  assert.equal(
    (await detail(boss, id)).unreadCount,
    2,
    'read cursor is per member',
  );
  pass(
    '备注并发同键只写一条、冲突 409、分页；不产生 AI 任务；未读仅访客且按成员隔离',
  );

  // Lost note response is retried with the identical request id and content.
  await winnerPage
    .getByRole('button', { name: '内部备注 · 仅团队可见' })
    .click();
  const noteKeys = [];
  let lose = true;
  await winnerPage.route(`**/conversations/${id}/notes`, async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    noteKeys.push(route.request().postDataJSON().clientNoteId);
    if (lose) {
      lose = false;
      await route.fetch();
      return route.abort();
    }
    return route.continue();
  });
  await winnerPage
    .getByLabel('内部备注（仅团队可见）')
    .fill('响应丢失后仍只保存一次');
  await winnerPage.getByRole('button', { name: '保存内部备注' }).click();
  await expect(
    winnerPage.getByRole('alert').filter({ hasText: '未确认' }),
  ).toBeVisible();
  await expect(winnerPage.getByLabel('内部备注（仅团队可见）')).toHaveValue(
    '响应丢失后仍只保存一次',
  );
  await winnerPage.getByRole('button', { name: '保存内部备注' }).click();
  await expect(
    winnerPage
      .locator('.inbox-note')
      .filter({ hasText: '响应丢失后仍只保存一次' }),
  ).toHaveCount(1);
  assert.equal(noteKeys.length, 2);
  assert.equal(noteKeys[0], noteKeys[1]);
  pass('备注提交响应丢失，保留输入并以同一 clientNoteId 恢复，无重复写入');

  await winnerPage
    .getByRole('button', { name: '公开消息', exact: true })
    .click();
  await winnerPage
    .getByRole('button', { name: '转交会话', exact: true })
    .click();
  await winnerPage.getByLabel('接待成员').selectOption(loser.membershipId);
  await winnerPage.getByLabel('操作理由').fill('交给同事继续处理');
  await request(loser, 'PATCH', '/memberships/me/availability', {
    availability: 'away',
  });
  await winnerPage
    .getByRole('button', { name: '确认操作', exact: true })
    .click();
  await expect(
    winnerPage.getByRole('alert').filter({ hasText: '409' }),
  ).toBeVisible();
  await expect(winnerPage.getByLabel('操作理由')).toHaveValue(
    '交给同事继续处理',
  );
  await expect(winnerPage.getByLabel('公开回复', { exact: true })).toHaveValue(
    '公开草稿不可覆盖',
  );
  await available(loser);
  await expect(
    winnerPage
      .getByLabel('接待成员')
      .locator(`option[value="${loser.membershipId}"]`),
  ).toHaveCount(1, { timeout: 10000 });
  await winnerPage.getByLabel('接待成员').selectOption(loser.membershipId);
  await winnerPage
    .getByRole('button', { name: '确认操作', exact: true })
    .click();
  await expect(
    winnerPage.getByRole('button', { name: '发送回复', exact: true }),
  ).toBeDisabled();
  await expect(winnerPage.getByLabel('公开回复', { exact: true })).toHaveValue(
    '公开草稿不可覆盖',
  );
  await expect(
    winnerPage.getByRole('region', { name: '公开消息记录' }),
  ).toHaveCount(0);
  await send(winner, id, '旧负责人发送', [403, 404]);
  await loserPage.getByRole('button', { name: '我的', exact: true }).click();
  await expect(loserPage.locator(`[data-conversation="${id}"]`)).toBeVisible();
  await loserPage.locator(`[data-conversation="${id}"]`).click();
  await expect(
    loserPage.getByRole('button', { name: '发送回复', exact: true }),
  ).toBeEnabled();
  await expect(loserPage.getByLabel('公开回复', { exact: true })).toHaveValue(
    '认领前保留的草稿',
  );
  pass('真实转交与授权列表刷新：原负责人失权且不能读取消息，双方本地输入保留');

  await loserPage
    .getByRole('button', { name: '关闭会话', exact: true })
    .click();
  await expect(
    loserPage.getByText('关闭后停止回复，已有工单的状态保持不变。'),
  ).toBeVisible();
  await loserPage
    .getByRole('button', { name: '确认操作', exact: true })
    .click();
  await expect(
    loserPage.getByRole('button', { name: '发送回复', exact: true }),
  ).toBeDisabled();
  await request(
    loser,
    'POST',
    `/conversations/${id}/notes`,
    { clientNoteId: randomUUID(), content: '关闭后禁止新增' },
    409,
  );
  await loserPage
    .getByRole('button', { name: '人工重开', exact: true })
    .click();
  await loserPage.getByLabel('操作理由').fill('继续核对订单');
  await loserPage
    .getByRole('button', { name: '确认操作', exact: true })
    .click();
  await expect(
    loserPage.getByRole('button', { name: '发送回复', exact: true }),
  ).toBeEnabled();
  assert.equal((await detail(boss, id)).status, 'human_active');
  pass('关闭/人工重开真实状态与输入保留；关闭会话备注只读，重开仍为人工');

  for (let i = 0; i < 52; i++) {
    await send(visitor, id, `历史消息 ${i + 1}`);
    await request(
      loser,
      'POST',
      `/conversations/${id}/notes`,
      { clientNoteId: randomUUID(), content: `历史内部备注 ${i + 1}` },
      201,
    );
  }
  await loserPage.reload();
  await expect(
    loserPage.locator('.inbox-message').filter({ hasText: '历史消息 52' }),
  ).toHaveCount(1, { timeout: 10000 });
  await expect(loserPage.locator('.inbox-message')).toHaveCount(50);
  await loserPage
    .getByRole('button', { name: '加载更早消息', exact: true })
    .click();
  await expect(
    loserPage
      .locator('.inbox-message')
      .filter({ hasText: '我需要修改订单，麻烦协助。' }),
  ).toHaveCount(1);
  await loserPage
    .getByLabel('公开回复', { exact: true })
    .fill('认领前保留的草稿');
  await loserPage
    .getByRole('button', { name: '内部备注 · 仅团队可见' })
    .click();
  await expect(loserPage.locator('.inbox-note')).toHaveCount(50);
  await loserPage
    .getByRole('button', { name: '更早备注', exact: true })
    .click();
  await expect(loserPage.locator('.inbox-note')).toHaveCount(55);
  await loserPage
    .getByLabel('内部备注（仅团队可见）')
    .fill('轮询不能覆盖备注草稿');
  await delay(3500);
  await expect(loserPage.locator('.inbox-note')).toHaveCount(55);
  await expect(loserPage.getByLabel('内部备注（仅团队可见）')).toHaveValue(
    '轮询不能覆盖备注草稿',
  );
  await expect(loserPage.getByLabel('内部备注（仅团队可见）')).toBeFocused();
  await loserPage
    .getByRole('button', { name: '公开消息', exact: true })
    .click();
  pass(
    '真实超过 50 条消息与备注：独立历史加载、分页刷新保留已加载范围，轮询不抢焦点或覆盖输入',
  );

  // Verify navigation preserves separate drafts and mobile list scroll, not just a screenshot.
  const other = (
    await request(
      visitor,
      'POST',
      '/conversations',
      {
        clientConversationId: randomUUID(),
        firstMessage: {
          clientMessageId: randomUUID(),
          content: '第二条咨询用于切换验证',
        },
      },
      201,
    )
  ).data.conversation;
  await loserPage
    .getByRole('button', { name: '全部有权', exact: true })
    .click();
  await expect(
    loserPage.locator(`[data-conversation="${other.id}"]`),
  ).toBeVisible();
  await loserPage.locator(`[data-conversation="${other.id}"]`).click();
  await loserPage.getByLabel('公开回复', { exact: true }).fill('第二会话草稿');
  await loserPage.locator(`[data-conversation="${id}"]`).click();
  await expect(loserPage.getByLabel('公开回复', { exact: true })).toHaveValue(
    '认领前保留的草稿',
  );
  await loserPage.setViewportSize({ width: 390, height: 844 });
  await loserPage.getByRole('button', { name: '客户资料 →' }).click();
  await expect(
    loserPage.getByRole('heading', { name: '客户资料' }),
  ).toBeVisible();
  await expect(
    loserPage.getByRole('button', { name: '发送回复', exact: true }),
  ).toBeHidden();
  await loserPage.getByRole('button', { name: '← 返回会话' }).click();
  await expect(loserPage.getByLabel('公开回复', { exact: true })).toHaveValue(
    '认领前保留的草稿',
  );
  await loserPage.getByRole('button', { name: '← 会话列表' }).click();
  await expect(
    loserPage.getByRole('heading', { name: '收件箱' }),
  ).toBeVisible();
  await loserPage.locator(`[data-conversation="${id}"]`).click();
  await expect(loserPage.getByLabel('公开回复', { exact: true })).toBeVisible();
  await loserPage.getByRole('button', { name: '← 会话列表' }).click();
  await loserPage.locator(`[data-conversation="${other.id}"]`).click();
  await expect(loserPage.getByLabel('公开回复', { exact: true })).toHaveValue(
    '第二会话草稿',
  );
  await loserPage.screenshot({ path: resolve(evidence, 'mobile-chat.png') });
  await loserPage.setViewportSize({ width: 1440, height: 1000 });
  pass(
    '不同会话草稿隔离；390px 小屏列表/聊天/客户资料逐层返回，输入与模式可操作',
  );

  // Loading and recoverable failures are deliberately injected at the HTTP boundary.
  let releaseList;
  const listGate = new Promise((r) => (releaseList = r));
  await adminPage.route('**/api/v1/conversations?*', async (route) => {
    await listGate;
    await route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({
        error: { code: 'SERVICE_UNAVAILABLE', message: 'injected' },
      }),
    });
  });
  await adminPage.reload();
  await expect(
    adminPage.getByRole('status').filter({ hasText: '正在载入工作台' }),
  ).toBeVisible();
  releaseList();
  await expect(
    adminPage.getByRole('alert').filter({ hasText: '服务暂时不可用' }),
  ).toBeVisible();
  await adminPage.unroute('**/api/v1/conversations?*');
  await adminPage.getByRole('button', { name: '重试列表' }).click();
  await expect(adminPage.locator('.inbox-list [role="alert"]')).toHaveCount(0);
  await adminPage.getByLabel('会话状态').selectOption('closed');
  await expect(
    adminPage.getByText('暂时没有等待接待的咨询', { exact: true }),
  ).toBeVisible();
  await adminPage.getByLabel('会话状态').selectOption('');
  await adminPage
    .getByRole('button', { name: '接管会话', exact: true })
    .click();
  await adminPage
    .getByLabel('公开回复', { exact: true })
    .fill('管理员接管后回复');
  await expect(
    adminPage.getByRole('button', { name: '发送回复', exact: true }),
  ).toBeEnabled();
  await adminPage
    .getByLabel('公开回复', { exact: true })
    .fill('管理员接管后回复');
  await adminPage
    .getByRole('button', { name: '发送回复', exact: true })
    .click();
  await expect(
    customer.getByRole('region', { name: '访客消息记录' }),
  ).toContainText('管理员接管后回复');
  await adminPage.screenshot({ path: resolve(evidence, 'desktop-inbox.png') });
  pass('实际加载/空/503 重试状态；管理员通过指派给自己接管后方能公开发送');

  const member = (
    await request(boss, 'GET', '/memberships?limit=100')
  ).data.items.find((m) => m.id === loser.membershipId);
  await request(boss, 'PATCH', `/memberships/${loser.membershipId}`, {
    expectedVersion: member.version,
    status: 'disabled',
  });
  await expect(
    loserPage.getByRole('alert').filter({ hasText: '权限已失效' }),
  ).toBeVisible({ timeout: 15000 });
  await expect(loserPage.getByLabel('公开回复', { exact: true })).toHaveCount(
    0,
  );
  await expect(loserPage.locator('.inbox-row')).toHaveCount(0);
  await send(loser, other.id, '停用成员发送', 404);
  await adminPage
    .getByRole('button', { name: '退出登录', exact: true })
    .click();
  await expect(adminPage).toHaveURL(web + '/login');
  await expect(adminPage.locator('.inbox-message')).toHaveCount(0);
  assert.deepEqual(errors, []);
  pass(
    '成员停用自动销毁私有界面与输入、后端拒绝发送；退出清理，浏览器无未捕获异常',
  );
  await writeFile(
    resolve(evidence, 'results.json'),
    JSON.stringify(
      {
        result: 'PASS',
        scenarios: results,
        browserContexts: contexts.length,
        database: name,
        web,
        api,
        modelCalls: 0,
        visitorSurface:
          'test-only real HTTP harness; T10 product widget not implemented',
      },
      null,
      2,
    ),
  );
} catch (error) {
  await writeFile(
    resolve(evidence, 'failure.log'),
    String(error.stack ?? error),
  );
  console.error(error);
  throw error;
} finally {
  for (let i = 0; i < contexts.length; i++) {
    await contexts[i].tracing.stop({
      path: resolve(evidence, `window-${i + 1}.zip`),
    });
  }
  await browser?.close();
  for (const item of children.reverse()) {
    if (!item.exit) item.child.kill();
    await item.done;
    await writeFile(resolve(evidence, `${item.label}.log`), item.output);
    await assert.rejects(() => fetch(item.health));
    console.info(
      JSON.stringify({
        stopped: item.pid,
        command: `node ${item.script}`,
        cwd: item.cwd,
        url: item.health,
        exit: item.exit,
      }),
    );
  }
  if (connected) await db.end();
  if (created) await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
  if (before) {
    const after = await snapshot();
    await writeFile(
      resolve(evidence, 'main-data.json'),
      JSON.stringify(
        {
          before,
          after,
          exclusions: ['presence_connections', 'outbox_events'],
        },
        null,
        2,
      ),
    );
    assert.deepEqual(after, before, 'experience business data changed');
  }
  await main.end();
  await admin.end();
  console.info(
    `CLEANUP PASS; ${results.length} groups; isolated processes and database removed`,
  );
}
