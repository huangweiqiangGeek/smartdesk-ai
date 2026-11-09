// T08归档接口验证：仅连接调用方已经启动的隔离实例，不创建服务。
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import process from 'node:process';
import console from 'node:console';
/* global fetch, AbortSignal */
const base = process.env.API_BASE_URL,
  origin = process.env.APP_ORIGIN;
if (!base || !origin || !process.env.T08_FIXTURE)
  throw new Error('需要API_BASE_URL、APP_ORIGIN和T08_FIXTURE隔离身份');
const { boss, agent, visitor } = JSON.parse(process.env.T08_FIXTURE);
const endpoints = new Set();
async function call(a, method, path, body, expected = 200, mark = null) {
  const response = await fetch(base + '/api/v1' + path, {
    method,
    signal: AbortSignal.timeout(10000),
    headers: {
      Origin: origin,
      'Content-Type': 'application/json',
      'X-Requested-With': 'SmartDesk',
      'Idempotency-Key': randomUUID(),
      ...(a.token
        ? { Authorization: 'Bearer ' + a.token }
        : { Cookie: a.cookie, 'X-Organization-Id': a.org }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const value = await response.json();
  assert.equal(response.status, expected, JSON.stringify(value));
  assert.ok(value.requestId);
  if (mark) endpoints.add(mark);
  return value.data;
}
async function run() {
  const preference = await call(
    agent,
    'PATCH',
    '/memberships/me/availability',
    { availability: 'available', readingLanguage: 'zh' },
    200,
    'A015',
  );
  assert.equal(preference.availability, 'available');
  const heart = await call(
    agent,
    'POST',
    '/presence/heartbeat',
    { connectionId: randomUUID() },
    200,
    'A016',
  );
  assert.equal(
    Date.parse(heart.onlineUntil) - Date.parse(heart.serverTime),
    60000,
  );
  assert.ok(
    (await call(boss, 'GET', '/presence', undefined, 200, 'A017')).some(
      (m) => m.id === agent.membershipId && m.online,
    ),
  );
  let c = (
    await call(
      visitor,
      'POST',
      '/conversations',
      {
        clientConversationId: randomUUID(),
        firstMessage: {
          clientMessageId: randomUUID(),
          content: 'T08归档验收合成咨询',
        },
      },
      201,
    )
  ).conversation;
  c = await call(
    visitor,
    'POST',
    `/conversations/${c.id}/handoff`,
    { reason: 'customer_request' },
    200,
    'A030',
  );
  assert.equal(c.status, 'waiting_human');
  c = await call(
    agent,
    'POST',
    `/conversations/${c.id}/claim`,
    { expectedVersion: c.version },
    200,
    'A031',
  );
  assert.equal(c.assignedMembershipId, agent.membershipId);
  c = await call(
    boss,
    'POST',
    `/conversations/${c.id}/assign`,
    { expectedVersion: c.version, membershipId: boss.membershipId },
    200,
    'A032',
  );
  assert.equal(c.assignedMembershipId, boss.membershipId);
  c = await call(
    boss,
    'POST',
    `/conversations/${c.id}/transfer`,
    {
      expectedVersion: c.version,
      membershipId: agent.membershipId,
      reason: '归档转交',
    },
    200,
    'A033',
  );
  c = await call(
    agent,
    'POST',
    `/conversations/${c.id}/close`,
    { expectedVersion: c.version, resolution: 'unconfirmed' },
    200,
    'A034',
  );
  assert.equal(c.status, 'closed');
  c = await call(
    agent,
    'POST',
    `/conversations/${c.id}/reopen`,
    { expectedVersion: c.version, reason: '归档人工重开' },
    200,
    'A035',
  );
  assert.equal(c.status, 'human_active');
  const read = await call(
    agent,
    'POST',
    `/conversations/${c.id}/read`,
    { lastReadSeq: c.lastSeq },
    200,
    'A036',
  );
  assert.equal(read.lastReadSeq, c.lastSeq);
  const events = await call(
    boss,
    'GET',
    `/conversations/${c.id}/events`,
    undefined,
    200,
    'A037',
  );
  assert.ok(events.items.length >= 5);
  assert.ok(events.items.some((e) => e.type === 'reopen'));
  const saved = await call(boss, 'GET', `/conversations/${c.id}`);
  assert.equal(saved.version, c.version);
  assert.equal(saved.assignedMembershipId, agent.membershipId);
  assert.equal(saved.status, 'human_active');
  assert.equal(endpoints.size, 11);
  console.log('PASS T08归档接口11/11，状态和事件已持久化读回');
}
run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
